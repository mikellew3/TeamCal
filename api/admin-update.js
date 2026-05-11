import {
  serviceClient, readJson, send, methodGuard, verifyAdminToken,
  ALL_TYPES, TYPE_LABEL, TIME_AWAY_TYPES,
  isYmd, isHttpUrl, formatRange, logAdminAction,
} from './_lib.js';
import { sendPush } from './_push.js';

// POST { token, id, patch } → admin edits. Pushes "Request updated" to the
// member if the entry has one (covers all categories that are member-owned).
export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;
  const body = await readJson(req);
  if (!verifyAdminToken(body?.token)) return send(res, 401, { error: 'unauthorized' });

  const { id, patch, remove_day } = body || {};
  if (!id) return send(res, 400, { error: 'invalid_payload' });

  // Special form: trim/split a single day out of a multi-day entry.
  if (remove_day) {
    if (!isYmd(remove_day)) return send(res, 400, { error: 'invalid_dates' });
    return await handleRemoveDay({ id, remove_day, res });
  }

  if (!patch || typeof patch !== 'object') {
    return send(res, 400, { error: 'invalid_payload' });
  }

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
  if ('status' in patch) {
    if (!['pending', 'approved', 'denied'].includes(patch.status)) return send(res, 400, { error: 'invalid_status' });
    update.status = patch.status;
    update.decided_at = patch.status === 'pending' ? null : new Date().toISOString();
    update.decided_by = patch.status === 'pending' ? null : 'admin';
  }

  if (Object.keys(update).length === 0) return send(res, 400, { error: 'no_changes' });

  try {
    const supa = serviceClient();
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
  } catch (err) {
    console.error('admin-update', err);
    return send(res, 500, { error: 'server_error' });
  }
}

function addDay(ymd, delta) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

async function handleRemoveDay({ id, remove_day, res }) {
  try {
    const supa = serviceClient();
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

    // Single-day entry: removing the only day = delete entirely.
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

    // Trim from the start.
    if (remove_day === cur.start_date) {
      const newStart = addDay(remove_day, 1);
      const { data, error } = await supa.from('calendar_entries')
        .update({ start_date: newStart })
        .eq('id', id).select('*').single();
      if (error) throw error;
      logAdminAction(supa, { actor: null, action: 'entry_remove_day_trim', target_type: 'calendar_entry', target_id: id, payload: { day: remove_day, side: 'start' } });
      return send(res, 200, { entry: data, trimmed: 'start' });
    }

    // Trim from the end.
    if (remove_day === cur.end_date) {
      const newEnd = addDay(remove_day, -1);
      const { data, error } = await supa.from('calendar_entries')
        .update({ end_date: newEnd })
        .eq('id', id).select('*').single();
      if (error) throw error;
      logAdminAction(supa, { actor: null, action: 'entry_remove_day_trim', target_type: 'calendar_entry', target_id: id, payload: { day: remove_day, side: 'end' } });
      return send(res, 200, { entry: data, trimmed: 'end' });
    }

    // Middle day: shrink original to end before the removed day, insert
    // a new row picking up after it.
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
  } catch (err) {
    console.error('admin-update remove_day', err);
    return send(res, 500, { error: 'server_error' });
  }
}
