// GET /api/ghl-check: shows whether the GoHighLevel connection is set up, without revealing any secrets.
import { ghl, ghlKey, locationId, resolveLocationId, calendarFor, env, CLINIC_TZ } from "./_ghl.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const out = {
    settings: {
      GHL_API_KEY: ghlKey() ? `set (${ghlKey().slice(0, 7)}…)` : "MISSING",
      GHL_CALENDAR_ID: env("GHL_CALENDAR_ID") || "MISSING",
      GHL_CALENDAR_ID_ONLINE: env("GHL_CALENDAR_ID_ONLINE") || "(not set, uses GHL_CALENDAR_ID)",
      GHL_LOCATION_ID: locationId(),
      GHL_WEBHOOK_URL: env("GHL_WEBHOOK_URL") ? "set" : "MISSING",
    },
    checks: {},
  };
  if (!ghlKey() || !calendarFor("inPerson")) return res.status(200).json(out);

  await resolveLocationId();
  out.settings.GHL_LOCATION_ID = locationId() || "unknown";
  const msg = (r) => (r.json && (r.json.message || r.json.error)) || (r.text || "").slice(0, 200);
  try {
    const cal = await ghl(`/calendars/${encodeURIComponent(calendarFor("inPerson"))}`);
    out.checks.read_calendar = cal.ok
      ? `OK – "${(cal.json && cal.json.calendar && cal.json.calendar.name) || "calendar found"}"`
      : `FAILED ${cal.status}: ${msg(cal)}`;

    const now = Date.now();
    const fs = await ghl(`/calendars/${encodeURIComponent(calendarFor("inPerson"))}/free-slots`, {
      query: { startDate: now, endDate: now + 7 * 864e5, timezone: CLINIC_TZ },
    });
    if (fs.ok) {
      const days = Object.entries(fs.json || {}).filter(([, v]) => v && Array.isArray(v.slots));
      const sample = days.slice(0, 2).map(([d, v]) => `${d}: ${v.slots.slice(0, 4).join(", ")}`);
      out.checks.free_slots = days.length ? `OK – ${days.length} days with open times. ${sample.join(" | ")}` : "OK but NO open times returned for the next 7 days (check calendar availability)";
    } else out.checks.free_slots = `FAILED ${fs.status}: ${msg(fs)}`;

    const ct = await ghl(`/contacts/`, { version: "2021-07-28", query: { locationId: locationId(), limit: 1 } });
    out.checks.contacts_access = ct.ok ? "OK" : `FAILED ${ct.status}: ${msg(ct)} (needs contacts scopes)`;
  } catch (e) {
    out.checks.error = "Could not reach GoHighLevel";
  }
  return res.status(200).json(out);
}
