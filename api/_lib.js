// Shared helpers for serverless functions.
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

export const TIME_AWAY_TYPES = ['pto', 'cme'];
export const EVENT_TYPES     = ['note', 'onb', 'shd'];
export const COVERAGE_TYPES  = ['per_diem', 'swp'];
export const ALL_TYPES = [...TIME_AWAY_TYPES, ...EVENT_TYPES, ...COVERAGE_TYPES];

export const TYPE_LABEL = {
  pto: 'PTO', cme: 'CME',
  note: 'Note', onb: 'Onboarding', shd: 'Shadowing',
  per_diem: 'Per Diem', swp: 'Swap',
};

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

export function isHttpUrl(s) {
  if (typeof s !== 'string') return false;
  try {
    const u = new URL(s.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

// Curated palette — chip dots are picked first-come, first-served from this
// list. Once exhausted (17th member onward), we fall back to a deterministic
// HSL derived from the member's name so the team can grow without recoloring.
export const COLOR_PALETTE = [
  '#1f6b6b','#7a4e2d','#2d5f3f','#8b2c3d','#4a4a7a','#a85a1f',
  '#3a4a7a','#6b3a6e','#5e7a2d','#a8492e','#2d4f7a','#7a5a2d',
  '#4a6e5e','#6e2d4a','#3a5a6e','#8b6e2d',
];

export async function nextAvailableColor(supa, nameForFallback = '') {
  const { data, error } = await supa.from('team_members').select('color');
  if (error) return COLOR_PALETTE[0];
  const used = new Set((data || []).map(m => (m.color || '').toLowerCase()));
  for (const c of COLOR_PALETTE) if (!used.has(c.toLowerCase())) return c;
  return colorFromName(nameForFallback);
}

export function colorFromName(name) {
  const s = String(name || '').trim().toLowerCase();
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  // Match the muted, hand-picked saturation/lightness of the curated palette.
  return `hsl(${hue}, 45%, 35%)`;
}

// Audit log helper. Writes to admin_actions table. Fire-and-forget — never
// fails the calling endpoint.
export async function logAdminAction(supa, { actor, action, target_type = null, target_id = null, payload = null }) {
  try {
    await supa.from('admin_actions').insert({
      actor_email: actor || process.env.ADMIN_EMAIL || 'admin',
      action, target_type, target_id, payload,
    });
  } catch (err) {
    console.error('audit log', err);
  }
}

export function dayCount(start, end) {
  const a = new Date(`${start}T00:00:00Z`);
  const b = new Date(`${end}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000) + 1;
}

export function formatRange(start, end) {
  const fmt = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US',
    { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  return start === end ? fmt(start) : `${fmt(start)} – ${fmt(end)}`;
}

// Time-away conflict check. `statusFilter` controls which existing entries
// count: 'active' = approved + pending; 'approved' = approved only.
export async function timeAwayConflicts(supabase, requesterId, startDate, endDate, statusFilter = 'active') {
  const days = expandDateRange(startDate, endDate);
  const statuses = statusFilter === 'approved' ? ['approved'] : ['approved', 'pending'];
  const { data, error } = await supabase
    .from('calendar_entries')
    .select('id, member_id, start_date, end_date, event_type, status, team_members(name)')
    .in('event_type', TIME_AWAY_TYPES)
    .in('status', statuses)
    .lte('start_date', endDate)
    .gte('end_date', startDate);
  if (error) throw error;

  const byDay = new Map(days.map(d => [d, new Map()]));
  for (const e of data || []) {
    if (!e.member_id || e.member_id === requesterId) continue;
    for (const day of days) {
      if (day >= e.start_date && day <= e.end_date) {
        const m = byDay.get(day);
        if (!m.has(e.member_id)) m.set(e.member_id, e.team_members?.name || 'Unknown');
      }
    }
  }
  return {
    dayCounts: days.map(day => ({
      day,
      others_off: byDay.get(day).size,
      names: Array.from(byDay.get(day).values()).sort(),
    })),
  };
}

export function classifyConflict(dayCounts) {
  const blocked = dayCounts.filter(d => d.others_off >= 2);
  if (blocked.length > 0) return { state: 'block', reason: 'two_off', blockedDays: blocked };
  const overlap = dayCounts.filter(d => d.others_off >= 1);
  if (overlap.length > 0) {
    return { state: 'watch', reason: 'single_overlap', blockedDays: overlap };
  }
  return { state: 'clear', reason: null, blockedDays: [] };
}
