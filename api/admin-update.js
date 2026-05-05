import {
  serviceClient, readJson, send, methodGuard, verifyAdminToken,
  ALL_TYPES, isYmd,
} from './_lib.js';

// POST { token, id, patch: { event_type?, member_id?, title?, start_date?, end_date?, notes?, status? } }
// Edit any field on any entry. No conflict check — admin override.
export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;
  const body = await readJson(req);
  if (!verifyAdminToken(body?.token)) return send(res, 401, { error: 'unauthorized' });

  const { id, patch } = body || {};
  if (!id || !patch || typeof patch !== 'object') {
    return send(res, 400, { error: 'invalid_payload' });
  }

  const update = {};
  if ('event_type' in patch) {
    if (!ALL_TYPES.includes(patch.event_type)) return send(res, 400, { error: 'invalid_type' });
    update.event_type = patch.event_type;
  }
  if ('member_id' in patch) {
    update.member_id = patch.member_id || null;
  }
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
  if ('status' in patch) {
    if (!['pending', 'approved', 'denied'].includes(patch.status)) return send(res, 400, { error: 'invalid_status' });
    update.status = patch.status;
    update.decided_at = patch.status === 'pending' ? null : new Date().toISOString();
    update.decided_by = patch.status === 'pending' ? null : 'admin';
  }

  if (Object.keys(update).length === 0) {
    return send(res, 400, { error: 'no_changes' });
  }

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
    return send(res, 200, { entry: data });
  } catch (err) {
    console.error('admin-update', err);
    return send(res, 500, { error: 'server_error' });
  }
}
