import {
  serviceClient, readJson, send, methodGuard, verifyAdminToken,
  TIME_AWAY_TYPES, TYPE_LABEL,
  timeAwayConflicts, classifyConflict, effectiveTimeAwayRange,
  formatRange, logAdminAction,
} from './_lib.js';
import { sendPush } from './_push.js';

// POST { token, id, status, override?, decision_note? }
//   → approve / deny / reset to pending.
// On approve, re-runs conflict check against APPROVED entries only. If a
// conflict exists, returns 409 unless override=true. On any successful
// decision, sends a push notification to the requesting member and
// persists the optional admin note on the entry (cleared on reset).
export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;
  const body = await readJson(req);
  if (!verifyAdminToken(body?.token)) return send(res, 401, { error: 'unauthorized' });

  const { id, status, override, decision_note } = body || {};
  if (!id || !['pending', 'approved', 'denied'].includes(status)) {
    return send(res, 400, { error: 'invalid_payload' });
  }
  const note = (typeof decision_note === 'string' && decision_note.trim())
    ? decision_note.trim().slice(0, 500)
    : null;

  try {
    const supa = serviceClient();
    const { data: entry, error: gErr } = await supa
      .from('calendar_entries')
      .select('*, team_members(name, email)')
      .eq('id', id)
      .maybeSingle();
    if (gErr) throw gErr;
    if (!entry) return send(res, 404, { error: 'not_found' });

    if (status === 'approved'
        && entry.member_id
        && TIME_AWAY_TYPES.includes(entry.event_type)
        && !override) {
      const effective = await effectiveTimeAwayRange(
        supa, entry.member_id, entry.start_date, entry.end_date, 'approved');
      const { dayCounts } = await timeAwayConflicts(
        supa, entry.member_id, effective.start, effective.end, 'approved');
      const verdict = classifyConflict(dayCounts);
      if (verdict.state === 'block') {
        return send(res, 409, {
          error: 'conflict',
          reason: verdict.reason,
          blocked_days: verdict.blockedDays,
          override_available: true,
          chained: effective.chained,
          effective_range: effective.chained ? { start: effective.start, end: effective.end } : undefined,
        });
      }
    }

    const patch = {
      status,
      decided_at: status === 'pending' ? null : new Date().toISOString(),
      decided_by: status === 'pending' ? null : 'admin',
      decision_note: status === 'pending' ? null : note,
    };
    const { data, error } = await supa
      .from('calendar_entries')
      .update(patch)
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw error;

    logAdminAction(supa, {
      actor: null, action: `entry_${status}`,
      target_type: 'calendar_entry', target_id: id,
      payload: { member_id: entry.member_id, event_type: entry.event_type, override: !!override },
    });

    // Push to the requesting member (only Time Away has a member).
    if (entry.member_id) {
      const typeLabel = TYPE_LABEL[entry.event_type] || entry.event_type;
      const range = formatRange(entry.start_date, entry.end_date);
      let title = '', bodyTxt = '';
      if (status === 'approved') {
        title = 'Request approved';
        bodyTxt = `Your ${typeLabel} ${range} was approved`;
      } else if (status === 'denied') {
        title = 'Request denied';
        bodyTxt = `Your ${typeLabel} ${range} needs review — open calendar`;
      } else {
        title = 'Request reopened';
        bodyTxt = `Your ${typeLabel} ${range} is pending again`;
      }
      if (note) bodyTxt += ` — "${note.length > 120 ? note.slice(0, 117) + '…' : note}"`;
      sendPush({
        recipientType: 'member',
        memberId: entry.member_id,
        payload: { title, body: bodyTxt, tag: `dec-${id}`, entryId: id, url: `/index.html?entry=${id}`, badge_count: 1 },
      }).catch(err => console.error('push member', err));
    }

    return send(res, 200, { entry: data });
  } catch (err) {
    console.error('admin-decide', err);
    return send(res, 500, { error: 'server_error' });
  }
}
