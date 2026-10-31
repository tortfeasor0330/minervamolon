// Vercel serverless function for Greenery Therapy Nook bookings.
//   kind "booking": sent when the patient submits the form (before paying), so the clinic
//                   has their mobile number to follow up on payment.
//   kind "receipt": sent when the patient uploads proof of payment.
//
// Delivery channels (configure one or both in Vercel → Project → Settings → Environment Variables):
//   GoHighLevel:  GHL_WEBHOOK_URL        – the "Inbound Webhook" trigger URL from a GHL workflow
//                 GHL_API_KEY            – sub-account Private Integration token (scope: medias.write);
//                                          receipts are uploaded to the sub-account's Media Storage
//                 GHL_RECEIPTS_FOLDER_ID – optional Media Storage folder id for receipts
//                 BLOB_READ_WRITE_TOKEN  – optional fallback host (Vercel Blob) if GHL_API_KEY is not set
//   Email:        RESEND_API_KEY, CLINIC_EMAIL, optional FROM_EMAIL (see README)

const MAX_RECEIPT_BYTES = 3.5 * 1024 * 1024;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clip = (s, n) => String(s ?? "").slice(0, n);

// Philippine mobile numbers to +63 format so GHL can text them (09xx xxx xxxx -> +639xxxxxxxxx)
function toE164(phone) {
  const d = String(phone).replace(/[^\d+]/g, "");
  if (/^\+\d{8,15}$/.test(d)) return d;
  if (/^09\d{9}$/.test(d)) return "+63" + d.slice(1);
  if (/^639\d{9}$/.test(d)) return "+" + d;
  return d;
}

let lastUploadError = "";
// Upload to the GoHighLevel sub-account's Media Storage (POST /medias/upload-file, Version 2021-07-28)
async function uploadReceiptToGHL({ bytes, contentType, filename }) {
  const key = process.env.GHL_API_KEY;
  if (!key) return null;
  try {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: contentType }), filename);
    form.append("name", filename);
    form.append("hosted", "false");
    if (process.env.GHL_RECEIPTS_FOLDER_ID) form.append("parentId", process.env.GHL_RECEIPTS_FOLDER_ID);
    const r = await fetch("https://services.leadconnectorhq.com/medias/upload-file", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, Version: "2021-07-28", Accept: "application/json" },
      body: form,
    });
    const t = await r.text();
    if (!r.ok) { console.error("GHL media upload error", r.status, t); lastUploadError = `ghl_media_${r.status}`; return null; }
    const j = JSON.parse(t);
    return { url: j.url || "", fileId: j.fileId || "" };
  } catch (e) {
    console.error("GHL media upload failed", e);
    lastUploadError = "ghl_media_unreachable";
    return null;
  }
}

async function uploadReceipt({ bytes, contentType, filename }) {
  const g = await uploadReceiptToGHL({ bytes, contentType, filename });
  if (g && g.url) return g;
  if (!process.env.BLOB_READ_WRITE_TOKEN) return { url: "", fileId: "" };
  try {
    const { put } = await import("@vercel/blob");
    const blob = await put(`receipts/${filename}`, bytes, { access: "public", contentType, addRandomSuffix: true });
    return { url: blob.url, fileId: "" };
  } catch (e) {
    console.error("Receipt upload failed", e);
    return { url: "", fileId: "" };
  }
}

async function sendToGHL(payload) {
  const url = process.env.GHL_WEBHOOK_URL;
  if (!url) return null;
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!r.ok) console.error("GHL webhook error", r.status, await r.text());
    return r.ok;
  } catch (e) {
    console.error("GHL webhook failed", e);
    return false;
  }
}

let lastEmailError = "";
async function sendEmail({ subject, html, text, replyTo, attachments }) {
  const { RESEND_API_KEY, CLINIC_EMAIL } = process.env;
  if (!RESEND_API_KEY || !CLINIC_EMAIL) return null;
  const FROM_EMAIL = process.env.FROM_EMAIL || "Greenery Therapy Nook <onboarding@resend.dev>";
  try {
    const payload = { from: FROM_EMAIL, to: CLINIC_EMAIL.split(",").map((s) => s.trim()).filter(Boolean), reply_to: replyTo, subject, html, text };
    if (attachments) payload.attachments = attachments;
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const t = await r.text();
      console.error("Resend error", r.status, t);
      let msg = ""; try { msg = JSON.parse(t).message || ""; } catch { msg = t; }
      lastEmailError = `resend_${r.status}: ${String(msg).slice(0, 160)}`;
    }
    return r.ok;
  } catch (e) {
    console.error("Email failed", e);
    lastEmailError = "resend_unreachable";
    return false;
  }
}

export default async function handler(req, res) {
  lastEmailError = "";
  lastUploadError = "";
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }
  const hasGHL = !!process.env.GHL_WEBHOOK_URL;
  const hasEmail = !!(process.env.RESEND_API_KEY && process.env.CLINIC_EMAIL);
  if (!hasGHL && !hasEmail) return res.status(503).json({ error: "not_configured" });

  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch { b = null; } }
  if (!b || typeof b !== "object") return res.status(400).json({ error: "bad_request" });

  const kind = b.kind === "receipt" ? "receipt" : "booking";
  const name = clip(b.name, 120).trim();
  const email = clip(b.email, 160).trim();
  const phone = clip(b.phone, 40).trim();
  if (!name || !/^\S+@\S+\.\S+$/.test(email) || phone.replace(/\D/g, "").length < 7) {
    return res.status(400).json({ error: "missing_fields" });
  }

  const when = `${clip(b.dateLabel, 80)}, ${clip(b.timeLabel, 20)}`;
  const nameParts = name.split(/\s+/);
  const ghl = {
    event: kind === "receipt" ? "receipt_uploaded" : "booking_created",
    booking_id: clip(b.id, 20),
    full_name: name,
    first_name: nameParts.slice(0, -1).join(" ") || name,
    last_name: nameParts.length > 1 ? nameParts[nameParts.length - 1] : "",
    email,
    phone: toE164(phone),
    phone_as_typed: phone,
    age: clip(b.age, 3),
    appointment_date: clip(b.date, 10),
    appointment_time: clip(b.timeLabel, 20),
    appointment_label: `${when} (${clip(b.tzLabel, 40)})`,
    consultation_type: clip(b.typeLabel, 80),
    consultation_mode: clip(b.modeLabel, 80),
    fee_summary: clip(b.fee, 120),
    patient_note: clip(b.reason, 600),
    payment_reference: "",
    receipt_url: "",
    receipt_file_id: "",
    receipt_file_name: "",
    source: "greenerytherapynook.com",
  };

  let attachments, subject, heading, intro, rows;

  if (kind === "receipt") {
    const r = b.receipt || {};
    const m = /^data:(image\/jpeg|image\/png|application\/pdf);base64,([A-Za-z0-9+/=]+)$/.exec(String(r.data || ""));
    if (!m) return res.status(400).json({ error: "missing_receipt" });
    if (m[2].length * 0.75 > MAX_RECEIPT_BYTES) return res.status(413).json({ error: "receipt_too_large" });
    const ext = m[1] === "application/pdf" ? "pdf" : m[1] === "image/png" ? "png" : "jpg";
    const filename = `receipt-${clip(b.date, 10)}-${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 40)}.${ext}`;
    attachments = [{ filename, content: m[2] }];
    ghl.payment_reference = clip(b.paymentRef, 60);
    if (hasGHL) {
      const up = await uploadReceipt({ bytes: Buffer.from(m[2], "base64"), contentType: m[1], filename });
      ghl.receipt_url = up.url;
      ghl.receipt_file_id = up.fileId;
      ghl.receipt_file_name = filename;
    }
    subject = `Payment receipt: ${name} · ${when}`;
    heading = "Payment receipt received";
    intro = "The patient uploaded proof of payment (attached). Please verify it and confirm the appointment.";
    rows = [
      ["Patient", name], ["Mobile", phone], ["Email", email],
      ["Appointment", ghl.appointment_label], ["Consultation", `${ghl.consultation_type} · ${ghl.consultation_mode}`],
      ["Fee", ghl.fee_summary || "Not set on site"], ["Payment reference", ghl.payment_reference || "See attached receipt"],
      ["Booking ID", ghl.booking_id],
    ];
  } else {
    subject = `New booking (awaiting payment): ${name} · ${when}`;
    heading = "New booking: awaiting payment";
    intro = "The patient has been shown the Landbank details. A second email arrives when they upload the receipt. If it doesn't come, follow up using the mobile number below.";
    rows = [
      ["Mobile", phone], ["Patient", name + (b.age ? ` (age ${clip(b.age, 3)})` : "")], ["Email", email],
      ["Appointment", ghl.appointment_label], ["Consultation", `${ghl.consultation_type} · ${ghl.consultation_mode}`],
      ["Fee", ghl.fee_summary || "Not set on site"], ["Note from patient", ghl.patient_note || "None"],
      ["Booking ID", ghl.booking_id],
    ];
  }

  const telHref = "tel:" + phone.replace(/[^\d+]/g, "");
  const cell = (k, v) => (k === "Mobile" ? `<a href="${esc(telHref)}" style="color:#1f6b4a;font-size:18px">${esc(v)}</a>` : `<b>${esc(v)}</b>`);
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1d2a24">
    <h2 style="color:#1f6b4a;margin:0 0 6px">${esc(heading)}</h2>
    <p style="margin:0 0 14px">${esc(intro)} Reply to this email to write to the patient.</p>
    <table cellpadding="6" style="border-collapse:collapse">${rows
      .map(([k, v]) => `<tr><td style="color:#5f6d66;vertical-align:top;white-space:nowrap">${esc(k)}</td><td>${cell(k, v)}</td></tr>`)
      .join("")}</table></div>`;
  const text = `${heading}\n${intro}\n\n` + rows.map(([k, v]) => `${k}: ${v}`).join("\n");

  const [ghlOk, emailOk] = await Promise.all([sendToGHL(ghl), sendEmail({ subject, html, text, replyTo: email, attachments })]);

  if (ghlOk || emailOk) return res.status(200).json({ ok: true, ghl: ghlOk, email: emailOk, receipt_hosted: !!ghl.receipt_url, upload_error: lastUploadError || undefined });
  return res.status(502).json({ error: ghlOk === false ? "ghl_failed" : "email_failed", detail: lastEmailError });
}
