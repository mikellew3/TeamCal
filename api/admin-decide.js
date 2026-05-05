import {
  serviceClient, readJson, send, methodGuard, verifyAdminToken,
  TIME_AWAY_TYPES, timeAwayConflicts, classifyConflict,
} from './_lib.js';

// POST { token, id, status, override? } → approve / deny / reset to pending.
// On approve, re-runs conflict check against APPROVED entries only. If a
// conflict exists, returns 409 unless override=true.
export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;
  const body = await readJson(req);
  if (!verifyAdminToken(body?.token)) return send(res, 401, { error: 'unauthorized' });

  const { id, status, override } = body || {};
  if (!id || !['pending', 'approved', 'denied'].includes(status)) {
    return send(res, 400, { error: 'invalid_payload' });
  }

  try {
    const supa = serviceClient();
    const { data: entry, error: gErr } = await supa
      .from('calendar_entries')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (gErr) throw gErr;
    if (!entry) return send(res, 404, { error: 'not_found' });

    // Approve flow with conflict re-check (against APPROVED only).
    if (status === 'approved'
        && entry.member_id
        && TIME_AWAY_TYPES.includes(entry.event_type)
        && !override) {
      const { dayCounts } = await timeAwayConflictsApprovedOnly(
        supa, entry.member_id, entry.start_date, entry.end_date);
      const verdict = classifyConflict(dayCounts);
      if (verdict.state === 'block') {
        return send(res, 409, {
          error: 'conflict',
          reason: verdict.reason,
          blocked_days: verdict.blockedDays,
          override_available: true,
        });
      }
    }

    const patch = {
      status,
      decided_at: status === 'pending' ? null : new Date().toISOString(),
      decided_by: status === 'pending' ? null : 'admin',
    };

    const { data, error } = await supa
      .from('calendar_entries')
      .update(patch)
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw error;
    return send(res, 200, { entry: data });
  } catch (err) {
    console.error('admin-decide', err);
    return send(res, 500, { error: 'server_error' });
  }
}

// Same as timeAwayConflicts in _lib.js but filters to status='approved' only.
async function timeAwayConflictsApprovedOnly(supabase, requesterId, startDate, endDate) {
  const { data, error } = await supabase
    .from('calendar_entries')
    .select('id, member_id, start_date, end_date, event_type, status, team_members(name)')
    .in('event_type', TIME_AWAY_TYPES)
    .eq('status', 'approved')
    .lte('start_date', endDate)
    .gte('end_date', startDate);
  if (error) throw error;

  const days = [];
  const start = new Date(`${startDate}T00:00:00Z`);
  const end   = new Date(`${endDate}T00:00:00Z`);
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    days.push(d.toISOString().slice(0, 10));
  }

  const byDay = new Map(days.map(d => [d, new Map()]));
  for (const e of data || []) {
    if (!e.member_id || e.member_id === requesterId) continue;
    for (const day of days) {
      if (day >= e.start_date && day <= e.end_date) {
        const m = byDay.get(day);
        if (!m.has(e.member_id)) m.set(e.member_id, e.team_members?.name || 'Unknown');
      }
    }
  }
  return {
    dayCounts: days.map(day => ({
      day,
      others_off: byDay.get(day).size,
      names: Array.from(byDay.get(day).values()).sort(),
    })),
  };
}
