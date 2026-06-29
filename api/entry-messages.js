import {
  serviceClient, readJson, send, methodGuard, verifyAdminToken,
  TYPE_LABEL, formatRange, logAdminAction,
} from './_lib.js';
import { sendPush } from './_push.js';

// POST { kind, ... } — entry-scoped thread + read-state + summary.
//
// Auth (either, accepted):
//   - Authorization: Bearer <jwt>  → member role; restricted to own entries
//   - admin_token in body          → admin role; any entry
//
// kinds:
//   'list'         { entry_id }              → { messages: [...] }
//   'post'         { entry_id, body }        → { message: {...} }      + push other party
//   'mark_read'    { entry_id }              → { marked: N }
//   'unread_count' { }                       → { count: N }            unread for caller
//   'discussions'  { limit? }                → { discussions: [...] }  entries with messages
export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;
  const body = await readJson(req);
  const kind = body?.kind;
  if (!['list', 'post', 'mark_read', 'unread_count', 'discussions'].includes(kind)) {
    return send(res, 400, { error: 'invalid_kind' });
  }

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

  try {
    if (kind === 'unread_count') return await unreadCount(supa, { isAdmin, callerMemberId }, res);
    if (kind === 'discussions')  return await discussionsSummary(supa, { isAdmin, callerMemberId, limit: body?.limit }, res);

    // entry-scoped kinds need entry_id
    const entryId = body?.entry_id;
    if (!entryId) return send(res, 400, { error: 'missing_entry_id' });

    // Confirm the entry exists and the member owns it (admin bypasses)
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

    if (kind === 'list')      return await listMessages(supa, entryId, res);
    if (kind === 'mark_read') return await markRead(supa, { entryId, isAdmin }, res);
    if (kind === 'post')      return await postMessage(supa, { entry, body: body?.body, isAdmin, callerMemberId, callerName }, res);
  } catch (err) {
    console.error('entry-messages', err);
    return send(res, 500, { error: 'server_error', detail: String(err?.message || err) });
  }
}

async function listMessages(supa, entryId, res) {
  const { data, error } = await supa
    .from('entry_messages')
    .select('id, entry_id, author_id, author_role, body, created_at, read_at')
    .eq('entry_id', entryId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return send(res, 200, { messages: data || [] });
}

// Mark every message in this entry that the CALLER didn't author as read.
async function markRead(supa, { entryId, isAdmin }, res) {
  // Admin reads member-authored messages; member reads admin-authored messages.
  const otherRole = isAdmin ? 'member' : 'admin';
  const { data, error } = await supa
    .from('entry_messages')
    .update({ read_at: new Date().toISOString() })
    .eq('entry_id', entryId)
    .eq('author_role', otherRole)
    .is('read_at', null)
    .select('id');
  if (error) throw error;
  return send(res, 200, { marked: (data || []).length });
}

async function unreadCount(supa, { isAdmin, callerMemberId }, res) {
  if (isAdmin) {
    const { count, error } = await supa
      .from('entry_messages')
      .select('id', { count: 'exact', head: true })
      .eq('author_role', 'member')
      .is('read_at', null);
    if (error) throw error;
    return send(res, 200, { count: count || 0 });
  }
  if (!callerMemberId) return send(res, 200, { count: 0 });
  // Find entries that belong to the caller, then count unread admin messages on them.
  const { data: entries } = await supa
    .from('calendar_entries')
    .select('id')
    .eq('member_id', callerMemberId);
  const ids = (entries || []).map(e => e.id);
  if (!ids.length) return send(res, 200, { count: 0 });
  const { count, error } = await supa
    .from('entry_messages')
    .select('id', { count: 'exact', head: true })
    .eq('author_role', 'admin')
    .is('read_at', null)
    .in('entry_id', ids);
  if (error) throw error;
  return send(res, 200, { count: count || 0 });
}

// Summary of entries that have messages, newest activity first. For admin
// returns everything; for member only their own entries.
async function discussionsSummary(supa, { isAdmin, callerMemberId, limit }, res) {
  const cap = Math.min(Math.max(parseInt(limit ?? 100, 10) || 100, 1), 300);
  let q = supa
    .from('entry_messages')
    .select('id, entry_id, author_role, body, created_at, read_at, author_id')
    .order('created_at', { ascending: false })
    .limit(cap * 4);    // overshoot a bit so we get enough distinct entries after grouping
  const { data: rows, error } = await q;
  if (error) throw error;

  // Group by entry, keep latest message + counts
  const byEntry = new Map();
  for (const m of rows || []) {
    let acc = byEntry.get(m.entry_id);
    if (!acc) {
      acc = { entry_id: m.entry_id, latest: m, total: 0, unread_for_admin: 0, unread_for_member: 0 };
      byEntry.set(m.entry_id, acc);
    }
    acc.total++;
    if (!m.read_at) {
      if (m.author_role === 'member') acc.unread_for_admin++;
      else acc.unread_for_member++;
    }
  }

  if (!byEntry.size) return send(res, 200, { discussions: [] });

  // Fetch entries
  const entryIds = Array.from(byEntry.keys());
  let eq = supa
    .from('calendar_entries')
    .select('id, member_id, event_type, title, start_date, end_date, status, team_members(name)')
    .in('id', entryIds);
  if (!isAdmin) eq = eq.eq('member_id', callerMemberId);
  const { data: entries, error: eErr } = await eq;
  if (eErr) throw eErr;

  const enriched = (entries || []).map(e => {
    const acc = byEntry.get(e.id);
    return {
      entry: e,
      latest_at: acc.latest.created_at,
      latest_preview: (acc.latest.body || '').slice(0, 120),
      latest_role: acc.latest.author_role,
      total_messages: acc.total,
      unread: isAdmin ? acc.unread_for_admin : acc.unread_for_member,
    };
  });
  enriched.sort((a, b) => (b.latest_at || '').localeCompare(a.latest_at || ''));
  return send(res, 200, { discussions: enriched.slice(0, cap) });
}

async function postMessage(supa, { entry, body, isAdmin, callerMemberId, callerName }, res) {
  const text = (typeof body === 'string' && body.trim()) ? body.trim() : '';
  if (!text) return send(res, 400, { error: 'empty_message' });
  if (text.length > 1000) return send(res, 400, { error: 'message_too_long' });

  const row = {
    entry_id: entry.id,
    author_id: isAdmin ? null : callerMemberId,
    author_role: isAdmin ? 'admin' : 'member',
    body: text,
  };
  const { data: msg, error: iErr } = await supa
    .from('entry_messages')
    .insert(row)
    .select('*')
    .single();
  if (iErr) throw iErr;

  // Compute fresh badge counts for the recipient and bake them into the push.
  let recipientBadge = 0;
  try {
    if (isAdmin && entry.member_id) {
      const { data: memEntries } = await supa.from('calendar_entries').select('id').eq('member_id', entry.member_id);
      const ids = (memEntries || []).map(x => x.id);
      if (ids.length) {
        const { count } = await supa.from('entry_messages').select('id', { count: 'exact', head: true })
          .eq('author_role', 'admin').is('read_at', null).in('entry_id', ids);
        recipientBadge = count || 0;
      }
    } else if (!isAdmin) {
      // Admin recipient: pending requests + unread member-authored messages.
      const [{ count: pending }, { count: unread }] = await Promise.all([
        supa.from('calendar_entries').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
        supa.from('entry_messages').select('id', { count: 'exact', head: true }).eq('author_role', 'member').is('read_at', null),
      ]);
      recipientBadge = (pending || 0) + (unread || 0);
    }
  } catch (e) { console.error('badge count', e); }

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
        tag: `msg-${entry.id}`,
        entryId: entry.id,
        url: `/index.html?entry=${entry.id}`,
        badge_count: recipientBadge,
      },
    }).catch(err => console.error('push msg', err));
  } else if (!isAdmin) {
    sendPush({
      recipientType: 'admin',
      payload: {
        title: `${callerName} commented — ${typeLabel} ${range}`,
        body: preview,
        tag: `msg-${entry.id}`,
        entryId: entry.id,
        url: `/index.html?entry=${entry.id}`,
        badge_count: recipientBadge,
      },
    }).catch(err => console.error('push msg', err));
  }

  if (isAdmin) {
    logAdminAction(supa, {
      actor: null, action: 'entry_message',
      target_type: 'calendar_entry', target_id: entry.id,
      payload: { length: text.length },
    });
  }
  return send(res, 200, { message: msg });
}
