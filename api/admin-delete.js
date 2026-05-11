import {
  serviceClient, readJson, send, methodGuard, verifyAdminToken,
  TYPE_LABEL, TIME_AWAY_TYPES, formatRange, logAdminAction,
} from './_lib.js';
import { sendPush } from './_push.js';

// POST { token, id } → delete an entry. Pushes "Request removed" to the
// member if the entry was theirs.
export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;
  const body = await readJson(req);
  if (!verifyAdminToken(body?.token)) return send(res, 401, { error: 'unauthorized' });

  const { id } = body || {};
  if (!id) return send(res, 400, { error: 'missing_id' });

  try {
    const supa = serviceClient();
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
  } catch (err) {
    console.error('admin-delete', err);
    return send(res, 500, { error: 'server_error' });
  }
}
