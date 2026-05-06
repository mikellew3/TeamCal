import {
  serviceClient, readJson, send, methodGuard, verifyAdminToken,
  ALL_TYPES, isYmd, isHttpUrl,
} from './_lib.js';

// POST { token, entry: { member_id?, event_type, title?, start_date, end_date, notes?, status?, conference_link? } }
// Admin direct-create. Bypasses conflict rules entirely. Time Away defaults
// to 'approved'. Events / Coverage Adds are forced to 'approved' (no status
// concept for those categories). NO push notifications fired here.
export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;
  const body = await readJson(req);
  if (!verifyAdminToken(body?.token)) return send(res, 401, { error: 'unauthorized' });

  const e = body?.entry || {};
  if (!ALL_TYPES.includes(e.event_type)) return send(res, 400, { error: 'invalid_type' });
  if (!isYmd(e.start_date) || !isYmd(e.end_date) || e.end_date < e.start_date) {
    return send(res, 400, { error: 'invalid_dates' });
  }
  const memberId = e.member_id || null;
  const title    = (typeof e.title === 'string' && e.title.trim()) ? e.title.trim() : null;
  if (!memberId && !title) return send(res, 400, { error: 'title_or_member_required' });

  const isTimeAway = ['pto', 'cme', 'pd'].includes(e.event_type);
  const status = isTimeAway && ['pending', 'approved', 'denied'].includes(e.status) ? e.status : 'approved';

  const conferenceLink = isHttpUrl(e.conference_link) ? e.conference_link.trim() : null;

  try {
    const supa = serviceClient();
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
        status,
        decided_at: status === 'pending' ? null : new Date().toISOString(),
        decided_by: status === 'pending' ? null : 'admin',
      })
      .select('*')
      .single();
    if (error) throw error;
    return send(res, 200, { entry: data });
  } catch (err) {
    console.error('admin-create', err);
    return send(res, 500, { error: 'server_error' });
  }
}
