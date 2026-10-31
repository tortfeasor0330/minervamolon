// Shared GoHighLevel helpers (files starting with "_" are not exposed as routes by Vercel).
export const GHL_BASE = "https://services.leadconnectorhq.com";
export const CLINIC_TZ = "Asia/Manila"; // UTC+8, no daylight saving
export const CLINIC_OFFSET = "+08:00";

export const env = (k, d = "") => String(process.env[k] || d).trim();
export const ghlKey = () => env("GHL_API_KEY");
export const locationId = () => env("GHL_LOCATION_ID", "XpqtEM1gWLlIYWwOvaQ2");
// One calendar for both modes, or a separate one for online sessions
export const calendarFor = (mode) =>
  mode === "online" ? env("GHL_CALENDAR_ID_ONLINE") || env("GHL_CALENDAR_ID") : env("GHL_CALENDAR_ID");

export async function ghl(path, { method = "GET", version = "2021-04-15", body, query } = {}) {
  const url = new URL(GHL_BASE + path);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  const r = await fetch(url.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${ghlKey()}`,
      Version: version,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { ok: r.ok, status: r.status, json, text };
}

// Hour of day in clinic time for an ISO timestamp
export function clinicHour(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = new Date(t + 8 * 3600e3);
  return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
}

export const pad = (n) => String(n).padStart(2, "0");
export const clinicISO = (date, hour) => `${date}T${pad(hour)}:00:00${CLINIC_OFFSET}`;
