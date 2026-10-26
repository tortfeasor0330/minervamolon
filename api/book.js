// Vercel serverless function: emails the clinic via Resend at two moments.
//   kind "booking": sent when the patient submits the form (before paying) so the clinic
//                   has their mobile number to follow up on payment.
//   kind "receipt": sent when the patient uploads proof of payment; the receipt is attached.
// Required environment variables (Vercel → Project → Settings → Environment Variables):
//   RESEND_API_KEY  – API key from resend.com
//   CLINIC_EMAIL    – where bookings are sent (comma-separate several addresses)
// Optional:
//   FROM_EMAIL      – sender, e.g. "Dr. Minerva Molon <bookings@yourdomain.com>" (needs a verified domain in Resend).
//                     Defaults to Resend's test sender, which only delivers to the Resend account's own email.

const MAX_RECEIPT_BYTES = 3.5 * 1024 * 1024;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clip = (s, n) => String(s ?? "").slice(0, n);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const { RESEND_API_KEY, CLINIC_EMAIL } = process.env;
  const FROM_EMAIL = process.env.FROM_EMAIL || "Clinic Bookings <onboarding@resend.dev>";
  if (!RESEND_API_KEY || !CLINIC_EMAIL) return res.status(503).json({ error: "not_configured" });

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
  const telHref = "tel:" + phone.replace(/[^\d+]/g, "");
  let attachments, subject, heading, intro, rows;

  if (kind === "receipt") {
    const r = b.receipt || {};
    const m = /^data:(image\/jpeg|image\/png|application\/pdf);base64,([A-Za-z0-9+/=]+)$/.exec(String(r.data || ""));
    if (!m) return res.status(400).json({ error: "missing_receipt" });
    if (m[2].length * 0.75 > MAX_RECEIPT_BYTES) return res.status(413).json({ error: "receipt_too_large" });
    const ext = m[1] === "application/pdf" ? "pdf" : m[1] === "image/png" ? "png" : "jpg";
    attachments = [{ filename: `receipt-${clip(b.date, 10)}-${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 40)}.${ext}`, content: m[2] }];
    subject = `Payment receipt: ${name} · ${when}`;
    heading = "Payment receipt received";
    intro = "The patient uploaded proof of payment (attached). Please verify it and confirm the appointment.";
    rows = [
      ["Patient", name],
      ["Mobile", phone],
      ["Email", email],
      ["Appointment", `${when} (${clip(b.tzLabel, 40)})`],
      ["Consultation", `${clip(b.typeLabel, 80)} · ${clip(b.modeLabel, 80)}`],
      ["Fee", clip(b.fee, 40) || "Not set on site"],
      ["Payment reference", clip(b.paymentRef, 60) || "See attached receipt"],
      ["Booking ID", clip(b.id, 20)],
    ];
  } else {
    subject = `New booking (awaiting payment): ${name} · ${when}`;
    heading = "New booking: awaiting payment";
    intro = "The patient has been shown the Landbank details. A second email arrives when they upload the receipt. If it doesn't come, follow up using the mobile number below.";
    rows = [
      ["Mobile", phone],
      ["Patient", name + (b.age ? ` (age ${clip(b.age, 3)})` : "")],
      ["Email", email],
      ["Appointment", `${when} (${clip(b.tzLabel, 40)})`],
      ["Consultation", `${clip(b.typeLabel, 80)} · ${clip(b.modeLabel, 80)}`],
      ["Fee", clip(b.fee, 40) || "Not set on site"],
      ["Note from patient", clip(b.reason, 600) || "None"],
      ["Booking ID", clip(b.id, 20)],
    ];
  }

  const cell = (k, v) =>
    k === "Mobile"
      ? `<a href="${esc(telHref)}" style="color:#1f6b4a;font-size:18px">${esc(v)}</a>`
      : `<b>${esc(v)}</b>`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1d2a24">
    <h2 style="color:#1f6b4a;margin:0 0 6px">${esc(heading)}</h2>
    <p style="margin:0 0 14px">${esc(intro)} Reply to this email to write to the patient.</p>
    <table cellpadding="6" style="border-collapse:collapse">${rows
      .map(([k, v]) => `<tr><td style="color:#5f6d66;vertical-align:top;white-space:nowrap">${esc(k)}</td><td>${cell(k, v)}</td></tr>`)
      .join("")}</table></div>`;
  const text = `${heading}\n${intro}\n\n` + rows.map(([k, v]) => `${k}: ${v}`).join("\n");

  try {
    const payload = {
      from: FROM_EMAIL,
      to: CLINIC_EMAIL.split(",").map((s) => s.trim()).filter(Boolean),
      reply_to: email,
      subject,
      html,
      text,
    };
    if (attachments) payload.attachments = attachments;
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      console.error("Resend error", resp.status, await resp.text());
      return res.status(502).json({ error: "email_failed" });
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("Send failed", e);
    return res.status(502).json({ error: "email_failed" });
  }
}
