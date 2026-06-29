import {
  serviceClient, readJson, send, methodGuard, verifyAdminToken,
  TYPE_LABEL, formatRange, logAdminAction,
} from './_lib.js';
import { sendPush } from './_push.js';

// POST { kind: 'list', entry_id }                  → { messages: [...] }
// POST { kind: 'post', entry_id, body }            → { message: {...} }
//
// Auth (either, accepted):
//   - Authorization: Bearer <jwt>  → member role; can only operate on their
//     own entries (entry.member_id === their team_members.id)
//   - admin_token in body          → admin role; any entry
//
// On post, fires a push to the OTHER party:
//   - member post → push admin
//   - admin post  → push the entry's member (if it has one)
export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;
  const body = await readJson(req);
  const kind = body?.kind;
  const entryId = body?.entry_id;
  if (!entryId) return send(res, 400, { error: 'missing_entry_id' });
  if (!['list', 'post'].includes(kind)) return send(res, 400, { error: 'invalid_kind' });

  let supa;
  try { supa = serviceClient(); }
  catch (e) { console.error(e); return send(res, 500, { error: 'server_error' }); }

  // Resolve caller
  const isAdmin = verifyAdminToken(body?.admin_token);
  let callerMemberId = null;
  let callerName = null;
  if (!isAdmin) {
    const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
    const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!jwt) return send(res, 401, { error: 'missing_token' });
    const { data: userData, error } = await supa.auth.getUser(jwt);
    if (error || !userData?.user) return send(res, 401, { error: 'invalid_token' });
    const { data: member } = await supa
      .from('team_members')
      .select('id, name, email, active')
      .eq('auth_user_id', userData.user.id)
      .maybeSingle();
    if (!member || member.active === false) return send(res, 403, { error: 'not_a_team_member' });
    callerMemberId = member.id;
    callerName = member.name;
  }

  // Confirm the entry exists and the member owns it (admin bypasses).
  const { data: entry, error: eErr } = await supa
    .from('calendar_entries')
    .select('id, member_id, event_type, start_date, end_date, title')
    .eq('id', entryId)
    .maybeSingle();
  if (eErr) { console.error(eErr); return send(res, 500, { error: 'server_error' }); }
  if (!entry) return send(res, 404, { error: 'entry_not_found' });
  if (!isAdmin && entry.member_id !== callerMemberId) {
    return send(res, 403, { error: 'not_your_entry' });
  }

  if (kind === 'list') {
    const { data, error } = await supa
      .from('entry_messages')
      .select('id, entry_id, author_id, author_role, body, created_at')
      .eq('entry_id', entryId)
      .order('created_at', { ascending: true });
    if (error) { console.error('entry-messages list', error); return send(res, 500, { error: 'server_error' }); }
    return send(res, 200, { messages: data || [] });
  }

  // kind === 'post'
  const text = (typeof body?.body === 'string' && body.body.trim()) ? body.body.trim() : '';
  if (!text) return send(res, 400, { error: 'empty_message' });
  if (text.length > 1000) return send(res, 400, { error: 'message_too_long' });

  const row = {
    entry_id: entryId,
    author_id: isAdmin ? null : callerMemberId,
    author_role: isAdmin ? 'admin' : 'member',
    body: text,
  };
  const { data: msg, error: iErr } = await supa
    .from('entry_messages')
    .insert(row)
    .select('*')
    .single();
  if (iErr) { console.error('entry-messages post', iErr); return send(res, 500, { error: 'server_error' }); }

  // Push the other party.
  const typeLabel = TYPE_LABEL[entry.event_type] || entry.event_type;
  const range = formatRange(entry.start_date, entry.end_date);
  const preview = text.length > 100 ? text.slice(0, 97) + '…' : text;
  if (isAdmin && entry.member_id) {
    sendPush({
      recipientType: 'member',
      memberId: entry.member_id,
      payload: {
        title: `Admin replied — ${typeLabel} ${range}`,
        body: preview,
        tag: `msg-${entryId}`,
        entryId,
        url: `/index.html?entry=${entryId}`,
      },
    }).catch(err => console.error('push msg', err));
  } else if (!isAdmin) {
    sendPush({
      recipientType: 'admin',
      payload: {
        title: `${callerName} commented — ${typeLabel} ${range}`,
        body: preview,
        tag: `msg-${entryId}`,
        entryId,
        url: `/index.html?entry=${entryId}`,
      },
    }).catch(err => console.error('push msg', err));
  }

  // Audit-log admin posts so the trail captures admin-initiated discussions.
  if (isAdmin) {
    logAdminAction(supa, {
      actor: null, action: 'entry_message',
      target_type: 'calendar_entry', target_id: entryId,
      payload: { length: text.length },
    });
  }

  return send(res, 200, { message: msg });
}
