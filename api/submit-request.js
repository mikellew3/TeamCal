import {
  serviceClient,
  readJson, send, methodGuard,
  TIME_AWAY_TYPES, TYPE_LABEL,
  isYmd, isHttpUrl,
  timeAwayConflicts, classifyConflict,
  dayCount, formatRange,
} from './_lib.js';
import { sendPush } from './_push.js';

// POST { event_type, start_date, end_date, notes?, conference_link? }
// with `Authorization: Bearer <jwt>`.
export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;

  const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!jwt) return send(res, 401, { error: 'missing_token' });

  let supa;
  try { supa = serviceClient(); } catch (e) {
    console.error(e); return send(res, 500, { error: 'server_error' });
  }

  const { data: userData, error: userErr } = await supa.auth.getUser(jwt);
  if (userErr || !userData?.user) return send(res, 401, { error: 'invalid_token' });
  const user = userData.user;

  let { data: member, error: mErr } = await supa
    .from('team_members')
    .select('id, name, email, active')
    .eq('auth_user_id', user.id)
    .maybeSingle();
  if (mErr) { console.error(mErr); return send(res, 500, { error: 'server_error' }); }
  if (!member && user.email) {
    const fallback = await supa
      .from('team_members')
      .select('id, name, email, active')
      .ilike('email', user.email)
      .maybeSingle();
    if (fallback.data) member = fallback.data;
  }
  if (!member) return send(res, 403, { error: 'not_a_team_member' });
  if (!member.active) return send(res, 403, { error: 'inactive_member' });

  const body = await readJson(req);
  const { event_type, start_date, end_date, notes, conference_link } = body || {};

  if (!TIME_AWAY_TYPES.includes(event_type)) {
    return send(res, 400, { error: 'invalid_type', detail: 'Members may only submit time-away requests.' });
  }
  if (!isYmd(start_date) || !isYmd(end_date)) {
    return send(res, 400, { error: 'invalid_dates' });
  }
  if (end_date < start_date) {
    return send(res, 400, { error: 'invalid_date_range' });
  }
  if (event_type === 'cme') {
    if (!isHttpUrl(conference_link)) {
      return send(res, 400, { error: 'conference_link_required', detail: 'CME requests require a valid conference link (http/https URL).' });
    }
  }

  let conflicts;
  try {
    conflicts = await timeAwayConflicts(supa, member.id, start_date, end_date, 'active');
  } catch (e) {
    console.error('conflict-check', e);
    return send(res, 500, { error: 'server_error' });
  }
  const verdict = classifyConflict(conflicts.dayCounts);
  if (verdict.state === 'block') {
    return send(res, 409, {
      error: 'conflict',
      reason: verdict.reason,
      blocked_days: verdict.blockedDays,
    });
  }

  const insert = await supa
    .from('calendar_entries')
    .insert({
      member_id: member.id,
      event_type,
      start_date,
      end_date,
      status: 'pending',
      notes: typeof notes === 'string' && notes.trim() ? notes.trim() : null,
      conference_link: event_type === 'cme' && isHttpUrl(conference_link) ? conference_link.trim() : null,
    })
    .select('*')
    .single();

  if (insert.error) {
    console.error('insert', insert.error);
    return send(res, 500, { error: 'insert_failed' });
  }

  const entry = insert.data;
  const days = dayCount(entry.start_date, entry.end_date);
  const range = formatRange(entry.start_date, entry.end_date);
  const typeLabel = TYPE_LABEL[entry.event_type] || entry.event_type;

  // Fire-and-forget admin notifications: push + email.
  sendPush({
    recipientType: 'admin',
    payload: {
      title: `New ${typeLabel} request`,
      body: `${member.name} requested ${days} day${days === 1 ? '' : 's'} — ${range}`,
      tag: `req-${entry.id}`,
      entryId: entry.id,
      url: `/index.html?entry=${entry.id}`,
    },
  }).catch(err => console.error('push admin', err));

  notifyAdmin(req, entry.id).catch(err => console.error('email admin', err));

  return send(res, 200, { id: entry.id, entry, watch: verdict.state === 'watch' });
}

async function notifyAdmin(req, entryId) {
  const proto = (req.headers['x-forwarded-proto'] || 'https').toString();
  const host  = req.headers['host'];
  if (!host) return;
  await fetch(`${proto}://${host}/api/notify-request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entry_id: entryId }),
  });
}
