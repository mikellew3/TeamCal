// Shared helpers for serverless functions.
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

export const TIME_AWAY_TYPES = ['pto', 'cme', 'pd'];
export const EVENT_TYPES     = ['note', 'onb', 'shd'];
export const COVERAGE_TYPES  = ['per_diem', 'swp'];
export const ALL_TYPES = [...TIME_AWAY_TYPES, ...EVENT_TYPES, ...COVERAGE_TYPES];

export function categoryFor(et) {
  if (TIME_AWAY_TYPES.includes(et)) return 'time_away';
  if (EVENT_TYPES.includes(et))     return 'events';
  if (COVERAGE_TYPES.includes(et))  return 'coverage_adds';
  return 'unknown';
}

export function serviceClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase env vars missing');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export function anonClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Supabase env vars missing');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

// Admin token: HMAC-SHA256(secret, "admin:" + dayNumber).
// Token is valid for the current day OR the previous day (24h grace window).
function dayNumber(date = new Date()) {
  return Math.floor(date.getTime() / 86_400_000);
}

function tokenFor(day) {
  const secret = process.env.ADMIN_TOKEN_SECRET;
  if (!secret) throw new Error('ADMIN_TOKEN_SECRET not set');
  return crypto.createHmac('sha256', secret).update(`admin:${day}`).digest('hex');
}

export function mintAdminToken() {
  return tokenFor(dayNumber());
}

export function verifyAdminToken(token) {
  if (!token || typeof token !== 'string') return false;
  const today = tokenFor(dayNumber());
  const yesterday = tokenFor(dayNumber() - 1);
  const buf = Buffer.from(token, 'hex');
  if (buf.length !== 32) return false;
  try {
    if (crypto.timingSafeEqual(buf, Buffer.from(today, 'hex'))) return true;
    if (crypto.timingSafeEqual(buf, Buffer.from(yesterday, 'hex'))) return true;
  } catch {
    return false;
  }
  return false;
}

export async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

export function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export function methodGuard(req, res, methods) {
  if (!methods.includes(req.method)) {
    res.setHeader('Allow', methods.join(', '));
    send(res, 405, { error: 'method_not_allowed' });
    return false;
  }
  return true;
}

// Build the list of dates (YYYY-MM-DD) covered by [start, end] inclusive.
export function expandDateRange(startStr, endStr) {
  const out = [];
  const start = new Date(`${startStr}T00:00:00Z`);
  const end   = new Date(`${endStr}T00:00:00Z`);
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

export function isYmd(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
}

// Time-away conflict check. Returns { blockedDays, others } where blockedDays
// is an array of { day, names[] } for days where 1+ OTHER members have a
// time-away entry (approved OR pending) overlapping that day.
export async function timeAwayConflicts(supabase, requesterId, startDate, endDate) {
  const days = expandDateRange(startDate, endDate);
  const { data, error } = await supabase
    .from('calendar_entries')
    .select('id, member_id, start_date, end_date, event_type, status, team_members(name)')
    .in('event_type', TIME_AWAY_TYPES)
    .in('status', ['approved', 'pending'])
    .lte('start_date', endDate)
    .gte('end_date', startDate);
  if (error) throw error;

  const byDay = new Map();
  for (const day of days) byDay.set(day, new Map());

  for (const e of data || []) {
    if (!e.member_id) continue;
    if (e.member_id === requesterId) continue;
    for (const day of days) {
      if (day >= e.start_date && day <= e.end_date) {
        const dayMap = byDay.get(day);
        if (!dayMap.has(e.member_id)) {
          dayMap.set(e.member_id, e.team_members?.name || 'Unknown');
        }
      }
    }
  }

  const dayCounts = days.map(day => ({
    day,
    others_off: byDay.get(day).size,
    names: Array.from(byDay.get(day).values()).sort(),
  }));

  return { dayCounts };
}

// Apply conflict rules. `mode` controls which rule set to use.
//   'submit'  → reject if 2+ off any day, OR multi-day with any 1+ off
//   'approve' → only checks approved entries (caller should filter); same rules
export function classifyConflict(dayCounts) {
  const nDays = dayCounts.length;
  const blocked = dayCounts.filter(d => d.others_off >= 2);
  if (blocked.length > 0) {
    return { state: 'block', reason: 'two_off', blockedDays: blocked };
  }
  const overlap = dayCounts.filter(d => d.others_off >= 1);
  if (nDays >= 2 && overlap.length > 0) {
    return { state: 'block', reason: 'multiday_overlap', blockedDays: overlap };
  }
  if (nDays === 1 && overlap.length > 0) {
    return { state: 'watch', reason: 'single_day_double_up', blockedDays: overlap };
  }
  return { state: 'clear', reason: null, blockedDays: [] };
}
