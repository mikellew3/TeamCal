import {
  serviceClient,
  readJson,
  send,
  methodGuard,
  TIME_AWAY_TYPES,
  isYmd,
  timeAwayConflicts,
  classifyConflict,
} from './_lib.js';

// POST { event_type, start_date, end_date, notes? } with `Authorization: Bearer <jwt>`
// Submits a Time Away request for the authenticated team member.
//
// 1. Auth: resolve user from supabase JWT
// 2. Look up team_members row by auth_user_id (or email fallback)
// 3. Validate body, restrict to time-away types
// 4. Conflict check (rejects on `block` state)
// 5. Insert pending entry, fire-and-forget notify-request
export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;

  const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!jwt) return send(res, 401, { error: 'missing_token' });

  let supa;
  try { supa = serviceClient(); } catch (e) {
    console.error(e); return send(res, 500, { error: 'server_error' });
  }

  // Resolve auth user from the JWT.
  const { data: userData, error: userErr } = await supa.auth.getUser(jwt);
  if (userErr || !userData?.user) return send(res, 401, { error: 'invalid_token' });
  const user = userData.user;

  // Map auth user → team_members row.
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
  const { event_type, start_date, end_date, notes } = body || {};

  if (!TIME_AWAY_TYPES.includes(event_type)) {
    return send(res, 400, { error: 'invalid_type', detail: 'Members may only submit time-away requests.' });
  }
  if (!isYmd(start_date) || !isYmd(end_date)) {
    return send(res, 400, { error: 'invalid_dates' });
  }
  if (end_date < start_date) {
    return send(res, 400, { error: 'invalid_date_range' });
  }

  // Conflict check.
  let conflicts;
  try {
    conflicts = await timeAwayConflicts(supa, member.id, start_date, end_date);
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

  // Insert pending entry.
  const insert = await supa
    .from('calendar_entries')
    .insert({
      member_id: member.id,
      event_type,
      start_date,
      end_date,
      status: 'pending',
      notes: typeof notes === 'string' && notes.trim() ? notes.trim() : null,
    })
    .select('*')
    .single();

  if (insert.error) {
    console.error('insert', insert.error);
    return send(res, 500, { error: 'insert_failed' });
  }

  // Fire-and-forget admin notification.
  notifyAdmin(req, insert.data.id).catch(err => console.error('notify', err));

  return send(res, 200, { id: insert.data.id, entry: insert.data, watch: verdict.state === 'watch' });
}

async function notifyAdmin(req, entryId) {
  const proto = (req.headers['x-forwarded-proto'] || 'https').toString();
  const host  = req.headers['host'];
  if (!host) return;
  const url = `${proto}://${host}/api/notify-request`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entry_id: entryId }),
    });
  } catch (e) {
    console.error('notify fetch', e);
  }
}
