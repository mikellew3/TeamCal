import {
  serviceClient, readJson, send, methodGuard, resolveAdmin, sameId,
  ALL_TYPES, TYPE_LABEL, TIME_AWAY_TYPES, categoryFor,
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

  let action = body?.action;
  if (!action) {
    if (body?.remove_day) action = 'remove_day';
    else if (body?.id && body?.patch) action = 'update';
    else if (body?.entry) action = 'create';
  }

  try {
    const supa = serviceClient();
    const actor = await resolveAdmin(supa, body?.token);
    if (!actor) return send(res, 401, { error: 'unauthorized' });

    switch (action) {
      case 'create':     return await handleCreate(supa, body, res, actor);
      case 'update':     return await handleUpdate(supa, body, res, actor);
      case 'delete':     return await handleDelete(supa, body, res, actor);
      case 'remove_day': return await handleRemoveDay(supa, body, res, actor);
      case 'approve_removal': return await handleRemovalDecision(supa, body, res, actor, true);
      case 'deny_removal':    return await handleRemovalDecision(supa, body, res, actor, false);
      default:           return send(res, 400, { error: 'invalid_action' });
    }
  } catch (err) {
    console.error('admin-update', err);
    return send(res, 500, { error: 'server_error', detail: String(err?.message || err) });
  }
}

// The separation-of-duties rule, stated once. An Associate Admin may not put
// THEIR OWN time away into an approved state by any route. Filing it as
// pending is fine — that's just requesting, and an admin still decides it.
function selfApprovalBlocked(actor, { memberId, eventType, status }) {
  return !actor.caps.decideOwnTimeAway
      && !!memberId
      && sameId(memberId, actor.memberId)
      && TIME_AWAY_TYPES.includes(eventType)
      && status === 'approved';
}

const SELF_APPROVE_ERROR = {
  error: 'self_approve_forbidden',
  detail: 'You can’t approve your own time away. Save it as Pending and an admin will review it.',
};

async function handleCreate(supa, body, res, actor) {
  const e = body?.entry || {};
  if (!ALL_TYPES.includes(e.event_type)) return send(res, 400, { error: 'invalid_type' });
  if (!isYmd(e.start_date) || !isYmd(e.end_date) || e.end_date < e.start_date) {
    return send(res, 400, { error: 'invalid_dates' });
  }
  const memberId = e.member_id || null;
  const title    = (typeof e.title === 'string' && e.title.trim()) ? e.title.trim() : null;
  // Time Away and Coverage Adds MUST have a member — otherwise the chip
  // renders orphaned (' @ Site' with no name). Events (Note, Holiday,
  // etc.) may still be title-only.
  const cat = categoryFor(e.event_type);
  if ((cat === 'time_away' || cat === 'coverage_adds') && !memberId) {
    return send(res, 400, { error: 'member_required', detail: 'Time Away and Coverage Adds must have a member.' });
  }
  if (!memberId && !title) return send(res, 400, { error: 'title_or_member_required' });

  const isTimeAway = TIME_AWAY_TYPES.includes(e.event_type);
  const status = isTimeAway && ['pending', 'approved', 'denied'].includes(e.status) ? e.status : 'approved';

  // NOTE the default above: an admin-created entry lands as 'approved' unless
  // told otherwise. That makes Add Entry a self-approval route, so the rule
  // has to be checked here and not only in admin-decide.
  if (selfApprovalBlocked(actor, { memberId, eventType: e.event_type, status })) {
    return send(res, 403, SELF_APPROVE_ERROR);
  }

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
      decided_by: status === 'pending' ? null : (actor.name || actor.email || 'admin'),
    })
    .select('*')
    .single();
  if (error) throw error;
  logAdminAction(supa, {
    actor: actor.email, action: 'entry_create',
    target_type: 'calendar_entry', target_id: data.id,
    payload: { event_type: data.event_type, member_id: data.member_id, start_date: data.start_date, end_date: data.end_date, status: data.status, actor_role: actor.role },
  });
  return send(res, 200, { entry: data });
}

async function handleUpdate(supa, body, res, actor) {
  const { id, patch } = body || {};
  if (!id) return send(res, 400, { error: 'invalid_payload' });
  if (!patch || typeof patch !== 'object') return send(res, 400, { error: 'invalid_payload' });

  // Read the current row so the self-approval check runs against the RESULT
  // of the patch. Otherwise an Associate Admin could flip their own pending
  // entry to approved, or reassign someone else's approved entry to
  // themselves — both land in the same forbidden state.
  const { data: before, error: bErr } = await supa
    .from('calendar_entries')
    .select('member_id, event_type, status')
    .eq('id', id)
    .maybeSingle();
  if (bErr) throw bErr;
  if (!before) return send(res, 404, { error: 'not_found' });

  const nextMemberId = ('member_id' in patch) ? (patch.member_id || null) : before.member_id;
  const nextType     = ('event_type' in patch) ? patch.event_type : before.event_type;
  const nextStatus   = ('status' in patch) ? patch.status : before.status;
  if (selfApprovalBlocked(actor, { memberId: nextMemberId, eventType: nextType, status: nextStatus })) {
    return send(res, 403, SELF_APPROVE_ERROR);
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
  if ('attachment_path' in patch) {
    const p = patch.attachment_path;
    update.attachment_path = (typeof p === 'string' && p.trim()) ? p.trim() : null;
  }
  if ('status' in patch) {
    if (!['pending', 'approved', 'denied'].includes(patch.status)) return send(res, 400, { error: 'invalid_status' });
    update.status = patch.status;
    update.decided_at = patch.status === 'pending' ? null : new Date().toISOString();
    update.decided_by = patch.status === 'pending' ? null : (actor.name || actor.email || 'admin');
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
    actor: actor.email, action: 'entry_update',
    target_type: 'calendar_entry', target_id: id,
    payload: { fields: Object.keys(update), actor_role: actor.role },
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

async function handleDelete(supa, body, res, actor) {
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
    actor: actor.email, action: 'entry_delete',
    target_type: 'calendar_entry', target_id: id,
    payload: existing ? { member_id: existing.member_id, event_type: existing.event_type, actor_role: actor.role } : { actor_role: actor.role },
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

// Decide a member's request to cancel approved time away.
//   approve → the entry is deleted, same as any admin delete.
//   deny    → the flag is cleared and the entry stands, with an optional note.
// Approving the removal of your OWN time away is the same self-dealing as
// approving your own request — it just arrives by a different door — so the
// Associate Admin rule applies here too.
async function handleRemovalDecision(supa, body, res, actor, approve) {
  const { id, decision_note } = body || {};
  if (!id) return send(res, 400, { error: 'invalid_payload' });

  const { data: entry, error: gErr } = await supa
    .from('calendar_entries')
    .select('*, team_members(name)')
    .eq('id', id)
    .maybeSingle();
  if (gErr) throw gErr;
  if (!entry) return send(res, 404, { error: 'not_found' });
  if (!entry.removal_requested_at) {
    return send(res, 400, { error: 'no_request', detail: 'There is no removal request on this entry.' });
  }

  if (!actor.caps.decideOwnTimeAway
      && entry.member_id
      && sameId(entry.member_id, actor.memberId)
      && TIME_AWAY_TYPES.includes(entry.event_type)) {
    return send(res, 403, {
      error: 'self_decide_forbidden',
      detail: 'You can’t decide your own removal request. An admin has to review it.',
    });
  }

  const note = (typeof decision_note === 'string' && decision_note.trim())
    ? decision_note.trim().slice(0, 500) : null;
  const typeLabel = TYPE_LABEL[entry.event_type] || entry.event_type;
  const range = formatRange(entry.start_date, entry.end_date);

  if (approve) {
    const { error } = await supa.from('calendar_entries').delete().eq('id', id);
    if (error) throw error;
  } else {
    const { error } = await supa
      .from('calendar_entries')
      .update({ removal_requested_at: null, removal_reason: null, decision_note: note })
      .eq('id', id);
    if (error) throw error;
  }

  logAdminAction(supa, {
    actor: actor.email,
    action: approve ? 'removal_approved' : 'removal_denied',
    target_type: 'calendar_entry', target_id: id,
    payload: {
      member_id: entry.member_id, event_type: entry.event_type,
      reason: entry.removal_reason, actor_role: actor.role,
    },
  });

  if (entry.member_id) {
    let bodyTxt = approve
      ? `Your ${typeLabel} ${range} was removed`
      : `Your ${typeLabel} ${range} stays on the calendar`;
    if (note) bodyTxt += ` — "${note.length > 120 ? note.slice(0, 117) + '…' : note}"`;
    sendPush({
      recipientType: 'member',
      memberId: entry.member_id,
      payload: {
        title: approve ? 'Time away removed' : 'Removal declined',
        body: bodyTxt,
        tag: `rmdec-${id}`,
        entryId: approve ? undefined : id,
        url: approve ? '/index.html' : `/index.html?entry=${id}`,
        badge_count: 1,
      },
    }).catch(err => console.error('push removal decision', err));
  }

  return send(res, 200, { ok: true, removed: approve });
}

function addDay(ymd, delta) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

async function handleRemoveDay(supa, body, res, actor) {
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
      actor: actor.email, action: 'entry_remove_day_delete',
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
    logAdminAction(supa, { actor: actor.email, action: 'entry_remove_day_trim', target_type: 'calendar_entry', target_id: id, payload: { day: remove_day, side: 'start' } });
    return send(res, 200, { entry: data, trimmed: 'start' });
  }

  if (remove_day === cur.end_date) {
    const newEnd = addDay(remove_day, -1);
    const { data, error } = await supa.from('calendar_entries')
      .update({ end_date: newEnd })
      .eq('id', id).select('*').single();
    if (error) throw error;
    logAdminAction(supa, { actor: actor.email, action: 'entry_remove_day_trim', target_type: 'calendar_entry', target_id: id, payload: { day: remove_day, side: 'end' } });
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
  logAdminAction(supa, { actor: actor.email, action: 'entry_remove_day_split', target_type: 'calendar_entry', target_id: id, payload: { day: remove_day, new_id: rightRow.id } });
  return send(res, 200, { split: true, new_entry_id: rightRow.id });
}
