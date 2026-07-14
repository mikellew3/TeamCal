import {
  serviceClient, readJson, send, methodGuard, verifyAdminToken,
  ALL_TYPES, TYPE_LABEL, TIME_AWAY_TYPES,
  isYmd, isHttpUrl, formatRange, logAdminAction,
} from './_lib.js';
import { sendPush } from './_push.js';

// Admin entry dispatcher. POST { token, action, ... }
//   action: 'create'  → { entry: {...} }                           → handleCreate
//   action: 'update'  → { id, patch: {...} }                        → handleUpdate
//   action: 'delete'  → { id }                                      → handleDelete
//   action: 'remove_day' → { id, remove_day: 'YYYY-MM-DD' }         → handleRemoveDay
// For backwards compatibility, a body with no action but { id, patch } is
// treated as 'update', and { id, remove_day } is treated as 'remove_day'.
export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;
  const body = await readJson(req);
  if (!verifyAdminToken(body?.token)) return send(res, 401, { error: 'unauthorized' });

  let action = body?.action;
  if (!action) {
    if (body?.remove_day) action = 'remove_day';
    else if (body?.id && body?.patch) action = 'update';
    else if (body?.entry) action = 'create';
  }

  try {
    const supa = serviceClient();
    switch (action) {
      case 'create':     return await handleCreate(supa, body, res);
      case 'update':     return await handleUpdate(supa, body, res);
      case 'delete':     return await handleDelete(supa, body, res);
      case 'remove_day': return await handleRemoveDay(supa, body, res);
      default:           return send(res, 400, { error: 'invalid_action' });
    }
  } catch (err) {
    console.error('admin-update', err);
    return send(res, 500, { error: 'server_error', detail: String(err?.message || err) });
  }
}

async function handleCreate(supa, body, res) {
  const e = body?.entry || {};
  if (!ALL_TYPES.includes(e.event_type)) return send(res, 400, { error: 'invalid_type' });
  if (!isYmd(e.start_date) || !isYmd(e.end_date) || e.end_date < e.start_date) {
    return send(res, 400, { error: 'invalid_dates' });
  }
  const memberId = e.member_id || null;
  const title    = (typeof e.title === 'string' && e.title.trim()) ? e.title.trim() : null;
  if (!memberId && !title) return send(res, 400, { error: 'title_or_member_required' });

  const isTimeAway = TIME_AWAY_TYPES.includes(e.event_type);
  const status = isTimeAway && ['pending', 'approved', 'denied'].includes(e.status) ? e.status : 'approved';
  const conferenceLink = isHttpUrl(e.conference_link) ? e.conference_link.trim() : null;
  const attachmentPath = (typeof e.attachment_path === 'string' && e.attachment_path.trim()) ? e.attachment_path.trim() : null;

  const { data, error } = await supa
    .from('calendar_entries')
    .insert({
      member_id: memberId,
      event_type: e.event_type,
      title,
      start_date: e.start_date,
      end_date: e.end_date,
      notes: (typeof e.notes === 'string' && e.notes.trim()) ? e.notes.trim() : null,
      conference_link: conferenceLink,
      attachment_path: attachmentPath,
      status,
      decided_at: status === 'pending' ? null : new Date().toISOString(),
      decided_by: status === 'pending' ? null : 'admin',
    })
    .select('*')
    .single();
  if (error) throw error;
  logAdminAction(supa, {
    actor: null, action: 'entry_create',
    target_type: 'calendar_entry', target_id: data.id,
    payload: { event_type: data.event_type, member_id: data.member_id, start_date: data.start_date, end_date: data.end_date, status: data.status },
  });
  return send(res, 200, { entry: data });
}

async function handleUpdate(supa, body, res) {
  const { id, patch } = body || {};
  if (!id) return send(res, 400, { error: 'invalid_payload' });
  if (!patch || typeof patch !== 'object') return send(res, 400, { error: 'invalid_payload' });

  const update = {};
  if ('event_type' in patch) {
    if (!ALL_TYPES.includes(patch.event_type)) return send(res, 400, { error: 'invalid_type' });
    update.event_type = patch.event_type;
  }
  if ('member_id' in patch) update.member_id = patch.member_id || null;
  if ('title' in patch) {
    update.title = (typeof patch.title === 'string' && patch.title.trim()) ? patch.title.trim() : null;
  }
  if ('start_date' in patch) {
    if (!isYmd(patch.start_date)) return send(res, 400, { error: 'invalid_dates' });
    update.start_date = patch.start_date;
  }
  if ('end_date' in patch) {
    if (!isYmd(patch.end_date)) return send(res, 400, { error: 'invalid_dates' });
    update.end_date = patch.end_date;
  }
  if ('notes' in patch) {
    update.notes = (typeof patch.notes === 'string' && patch.notes.trim()) ? patch.notes.trim() : null;
  }
  if ('conference_link' in patch) {
    update.conference_link = isHttpUrl(patch.conference_link) ? patch.conference_link.trim() : null;
  }
  if ('attachment_path' in patch) {
    const p = patch.attachment_path;
    update.attachment_path = (typeof p === 'string' && p.trim()) ? p.trim() : null;
  }
  if ('status' in patch) {
    if (!['pending', 'approved', 'denied'].includes(patch.status)) return send(res, 400, { error: 'invalid_status' });
    update.status = patch.status;
    update.decided_at = patch.status === 'pending' ? null : new Date().toISOString();
    update.decided_by = patch.status === 'pending' ? null : 'admin';
  }
  if ('sort_order' in patch) {
    const n = patch.sort_order;
    update.sort_order = (n == null || Number.isNaN(Number(n))) ? null : Math.floor(Number(n));
  }
  if ('decision_note' in patch) {
    const n = patch.decision_note;
    update.decision_note = (typeof n === 'string' && n.trim()) ? n.trim().slice(0, 500) : null;
  }

  if (Object.keys(update).length === 0) return send(res, 400, { error: 'no_changes' });

  const { data, error } = await supa
    .from('calendar_entries')
    .update(update)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  if (data && data.start_date && data.end_date && data.end_date < data.start_date) {
    return send(res, 400, { error: 'invalid_date_range' });
  }

  logAdminAction(supa, {
    actor: null, action: 'entry_update',
    target_type: 'calendar_entry', target_id: id,
    payload: { fields: Object.keys(update) },
  });

  if (data?.member_id && TIME_AWAY_TYPES.includes(data.event_type)) {
    const typeLabel = TYPE_LABEL[data.event_type] || data.event_type;
    sendPush({
      recipientType: 'member',
      memberId: data.member_id,
      payload: {
        title: 'Request updated',
        body: `Your ${typeLabel} entry was modified by admin`,
        tag: `upd-${id}`,
        entryId: id,
        url: `/index.html?entry=${id}`,
      },
    }).catch(err => console.error('push update', err));
  }
  return send(res, 200, { entry: data });
}

async function handleDelete(supa, body, res) {
  const { id } = body || {};
  if (!id) return send(res, 400, { error: 'missing_id' });

  const { data: existing } = await supa
    .from('calendar_entries')
    .select('id, member_id, event_type, start_date, end_date')
    .eq('id', id)
    .maybeSingle();

  const { error } = await supa.from('calendar_entries').delete().eq('id', id);
  if (error) throw error;

  logAdminAction(supa, {
    actor: null, action: 'entry_delete',
    target_type: 'calendar_entry', target_id: id,
    payload: existing ? { member_id: existing.member_id, event_type: existing.event_type } : null,
  });

  if (existing?.member_id && TIME_AWAY_TYPES.includes(existing.event_type)) {
    const typeLabel = TYPE_LABEL[existing.event_type] || existing.event_type;
    const range = formatRange(existing.start_date, existing.end_date);
    sendPush({
      recipientType: 'member',
      memberId: existing.member_id,
      payload: {
        title: 'Request removed',
        body: `Your ${typeLabel} ${range} was removed`,
        tag: `del-${id}`,
      },
    }).catch(err => console.error('push delete', err));
  }
  return send(res, 200, { ok: true });
}

function addDay(ymd, delta) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

async function handleRemoveDay(supa, body, res) {
  const { id, remove_day } = body || {};
  if (!id) return send(res, 400, { error: 'invalid_payload' });
  if (!isYmd(remove_day)) return send(res, 400, { error: 'invalid_dates' });

  const { data: cur, error: gErr } = await supa
    .from('calendar_entries')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (gErr) throw gErr;
  if (!cur) return send(res, 404, { error: 'not_found' });

  if (remove_day < cur.start_date || remove_day > cur.end_date) {
    return send(res, 400, { error: 'day_not_in_range' });
  }

  if (cur.start_date === cur.end_date) {
    const { error } = await supa.from('calendar_entries').delete().eq('id', id);
    if (error) throw error;
    logAdminAction(supa, {
      actor: null, action: 'entry_remove_day_delete',
      target_type: 'calendar_entry', target_id: id,
      payload: { day: remove_day },
    });
    return send(res, 200, { deleted: true });
  }

  if (remove_day === cur.start_date) {
    const newStart = addDay(remove_day, 1);
    const { data, error } = await supa.from('calendar_entries')
      .update({ start_date: newStart })
      .eq('id', id).select('*').single();
    if (error) throw error;
    logAdminAction(supa, { actor: null, action: 'entry_remove_day_trim', target_type: 'calendar_entry', target_id: id, payload: { day: remove_day, side: 'start' } });
    return send(res, 200, { entry: data, trimmed: 'start' });
  }

  if (remove_day === cur.end_date) {
    const newEnd = addDay(remove_day, -1);
    const { data, error } = await supa.from('calendar_entries')
      .update({ end_date: newEnd })
      .eq('id', id).select('*').single();
    if (error) throw error;
    logAdminAction(supa, { actor: null, action: 'entry_remove_day_trim', target_type: 'calendar_entry', target_id: id, payload: { day: remove_day, side: 'end' } });
    return send(res, 200, { entry: data, trimmed: 'end' });
  }

  const leftEnd     = addDay(remove_day, -1);
  const rightStart  = addDay(remove_day,  1);
  const { error: lErr } = await supa.from('calendar_entries')
    .update({ end_date: leftEnd })
    .eq('id', id);
  if (lErr) throw lErr;
  const { data: rightRow, error: rErr } = await supa.from('calendar_entries').insert({
    member_id: cur.member_id,
    event_type: cur.event_type,
    title: cur.title,
    start_date: rightStart,
    end_date: cur.end_date,
    status: cur.status,
    notes: cur.notes,
    conference_link: cur.conference_link,
    decided_at: cur.decided_at,
    decided_by: cur.decided_by,
  }).select('*').single();
  if (rErr) throw rErr;
  logAdminAction(supa, { actor: null, action: 'entry_remove_day_split', target_type: 'calendar_entry', target_id: id, payload: { day: remove_day, new_id: rightRow.id } });
  return send(res, 200, { split: true, new_entry_id: rightRow.id });
}
