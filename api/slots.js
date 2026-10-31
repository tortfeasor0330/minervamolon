// GET /api/slots?mode=inPerson|online&from=YYYY-MM-DD&to=YYYY-MM-DD
// Returns the open start hours (clinic time) from the doctor's GoHighLevel calendar:
//   { ok: true, slots: { "2026-11-02": [9, 10, 14], ... } }
import { ghl, ghlKey, calendarFor, clinicHour, CLINIC_TZ, CLINIC_OFFSET } from "./_ghl.js";

const DAY = 864e5;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const mode = req.query.mode === "online" ? "online" : "inPerson";
  const calendarId = calendarFor(mode);
  if (!ghlKey() || !calendarId) return res.status(503).json({ error: "not_configured" });

  const re = /^\d{4}-\d{2}-\d{2}$/;
  const from = re.test(req.query.from || "") ? req.query.from : null;
  const to = re.test(req.query.to || "") ? req.query.to : null;
  if (!from || !to) return res.status(400).json({ error: "bad_range" });

  let start = Date.parse(`${from}T00:00:00${CLINIC_OFFSET}`);
  const end = Math.min(Date.parse(`${to}T23:59:59${CLINIC_OFFSET}`), start + 92 * DAY);

  const slots = {};
  try {
    // GHL limits the range per request, so ask in 30-day chunks
    while (start <= end) {
      const chunkEnd = Math.min(start + 30 * DAY - 1, end);
      const r = await ghl(`/calendars/${encodeURIComponent(calendarId)}/free-slots`, {
        query: { startDate: start, endDate: chunkEnd, timezone: CLINIC_TZ },
      });
      if (!r.ok) {
        console.error("GHL free-slots error", r.status, r.text);
        return res.status(502).json({ error: `ghl_${r.status}`, detail: (r.json && r.json.message) || "" });
      }
      for (const [key, val] of Object.entries(r.json || {})) {
        if (!val || !Array.isArray(val.slots)) continue;
        for (const iso of val.slots) {
          const c = clinicHour(iso);
          if (!c || c.minute !== 0) continue; // the site books on the hour
          (slots[c.date] ||= []).push(c.hour);
        }
      }
      start = chunkEnd + 1;
    }
    for (const d of Object.keys(slots)) slots[d] = [...new Set(slots[d])].sort((a, b) => a - b);
    return res.status(200).json({ ok: true, slots });
  } catch (e) {
    console.error("Slots failed", e);
    return res.status(502).json({ error: "ghl_unreachable" });
  }
}
