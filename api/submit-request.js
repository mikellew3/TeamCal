import {
  serviceClient,
  readJson, send, methodGuard,
  TIME_AWAY_TYPES, TYPE_LABEL,
  isYmd, isHttpUrl,
  timeAwayConflicts, classifyConflict, effectiveTimeAwayRange,
  summerCapCheck, SUMMER_PTO_LIMIT_DAYS,
  businessDaysBetween, formatRange,
} from './_lib.js';
import { sendPush } from './_push.js';

// POST { event_type, start_date, end_date, notes?, conference_link? }
// with `Authorization: Bearer <jwt>`.
export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;

  const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!jwt) return send(res, 401, { error: 'missing_token' });

  let supa;
  try { supa = serviceClient(); } catch (e) {
    console.error(e); return send(res, 500, { error: 'server_error' });
  }

  const { data: userData, error: userErr } = await supa.auth.getUser(jwt);
  if (userErr || !userData?.user) return send(res, 401, { error: 'invalid_token' });
  const user = userData.user;

  // 2FA is mandatory for submitting requests. Verify the user has at least one
  // verified TOTP factor. We look at the user record first (cheap) and fall
  // back to the admin API if the field isn't populated by the gotrue version.
  let hasVerifiedMfa = (user.factors || []).some(f => f.status === 'verified');
  if (!hasVerifiedMfa) {
    try {
      const { data: adminUser } = await supa.auth.admin.getUserById(user.id);
      hasVerifiedMfa = (adminUser?.user?.factors || []).some(f => f.status === 'verified');
    } catch (e) {
      console.error('mfa lookup', e);
    }
  }
  if (!hasVerifiedMfa) {
    return send(res, 403, {
      error: 'mfa_required',
      detail: 'Two-factor authentication must be enabled before submitting requests.',
    });
  }

  let { data: member, error: mErr } = await supa
    .from('team_members')
    .select('id, name, email, active')
    .eq('auth_user_id', user.id)
    .maybeSingle();
  if (mErr) { console.error(mErr); return send(res, 500, { error: 'server_error' }); }
  if (!member && user.email) {
    const fallback = await supa
      .from('team_members')
      .select('id, name, email, active')
      .ilike('email', user.email)
      .maybeSingle();
    if (fallback.data) member = fallback.data;
  }
  if (!member) return send(res, 403, { error: 'not_a_team_member' });
  if (!member.active) return send(res, 403, { error: 'inactive_member' });

  const body = await readJson(req);

  // Member self-withdraw path: cancel your own PTO/CME/General entries so
  // long as they start more than 2 weeks out. Anything closer must route
  // through admin (coverage may already be planned around it).
  if (body?.action === 'withdraw')        return handleWithdraw(supa, member, body, res);
  if (body?.action === 'request_removal') return handleRequestRemoval(supa, member, body, res);
  if (body?.action === 'cancel_removal')  return handleCancelRemoval(supa, member, body, res);

  const { event_type, start_date, end_date, notes, conference_link } = body || {};

  if (!TIME_AWAY_TYPES.includes(event_type)) {
    return send(res, 400, { error: 'invalid_type', detail: 'Members may only submit time-away requests.' });
  }
  if (!isYmd(start_date) || !isYmd(end_date)) {
    return send(res, 400, { error: 'invalid_dates' });
  }
  if (end_date < start_date) {
    return send(res, 400, { error: 'invalid_date_range' });
  }
  if (event_type === 'cme') {
    if (!isHttpUrl(conference_link)) {
      return send(res, 400, { error: 'conference_link_required', detail: 'CME requests require a valid conference link (http/https URL).' });
    }
  }

  // Run the conflict check against the EFFECTIVE range — the requester's
  // own pending/approved time-away that touches or abuts this request is
  // merged in, so a stream of one-day requests can't sidestep the
  // consecutive-overlap block.
  let effective, conflicts;
  try {
    effective = await effectiveTimeAwayRange(supa, member.id, start_date, end_date, 'active');
    conflicts = await timeAwayConflicts(supa, member.id, effective.start, effective.end, 'active');
  } catch (e) {
    console.error('conflict-check', e);
    return send(res, 500, { error: 'server_error' });
  }
  const verdict = classifyConflict(conflicts.dayCounts);
  if (verdict.state === 'block') {
    return send(res, 409, {
      error: 'conflict',
      reason: verdict.reason,
      blocked_days: verdict.blockedDays,
      chained: effective.chained,
      effective_range: effective.chained ? { start: effective.start, end: effective.end } : undefined,
    });
  }

  // Summer PTO cap (starting summer 2027): 10 business days per member
  // between Memorial Day and Labor Day, inclusive. Hard stop.
  if (event_type === 'pto') {
    try {
      const cap = await summerCapCheck(supa, member.id, start_date, end_date);
      if (cap) {
        return send(res, 409, {
          error: 'summer_cap',
          detail: `Summer PTO cap: ${cap.cap} business days between Memorial Day (${cap.winStart}) and Labor Day (${cap.winEnd}). You already have ${cap.currentUsed} approved/pending; this request would add ${cap.newDays}, putting you at ${cap.wouldTotal}.`,
          year: cap.year,
          current_used: cap.currentUsed,
          new_days: cap.newDays,
          would_total: cap.wouldTotal,
          cap: cap.cap,
          window_start: cap.winStart,
          window_end: cap.winEnd,
        });
      }
    } catch (e) {
      console.error('summer-cap-check', e);
      // Don't hard-fail the request on a cap-check error — better UX to
      // let it through and log for admin review than to blackhole PTO.
    }
  }
  // Watch state: require a note explaining the overlap.
  if (verdict.state === 'watch' && verdict.requiresNote) {
    const note = (typeof notes === 'string') ? notes.trim() : '';
    if (!note) {
      return send(res, 400, {
        error: 'note_required',
        detail: 'A note is required when overlapping with another member.',
      });
    }
  }

  const insert = await supa
    .from('calendar_entries')
    .insert({
      member_id: member.id,
      event_type,
      start_date,
      end_date,
      status: 'pending',
      notes: typeof notes === 'string' && notes.trim() ? notes.trim() : null,
      conference_link: event_type === 'cme' && isHttpUrl(conference_link) ? conference_link.trim() : null,
    })
    .select('*')
    .single();

  if (insert.error) {
    console.error('insert', insert.error);
    return send(res, 500, { error: 'insert_failed' });
  }

  const entry = insert.data;
  const days = businessDaysBetween(entry.start_date, entry.end_date);
  const range = formatRange(entry.start_date, entry.end_date);
  const typeLabel = TYPE_LABEL[entry.event_type] || entry.event_type;

  // Total pending requests — used as the iOS home-screen badge count.
  const { count: pendingCount } = await supa
    .from('calendar_entries')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending');

  // Push admins; await it so we can return the result for debugging.
  let pushResult;
  try {
    pushResult = await sendPush({
      recipientType: 'admin',
      payload: {
        title: `New ${typeLabel} request`,
        body: `${member.name} requested ${days} day${days === 1 ? '' : 's'} — ${range}`,
        tag: `req-${entry.id}`,
        entryId: entry.id,
        url: `/index.html?entry=${entry.id}`,
        badge_count: pendingCount ?? 0,
      },
    });
  } catch (err) {
    console.error('push admin', err);
    pushResult = { sent: 0, reason: 'exception', error: String(err?.message || err) };
  }

  sendAdminEmail({ memberName: member.name, typeLabel, days, range, notes: entry.notes })
    .catch(err => console.error('email admin', err));

  return send(res, 200, { id: entry.id, entry, watch: verdict.state === 'watch', push: pushResult });
}

async function sendAdminEmail({ memberName, typeLabel, days, range, notes }) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const RESEND_FROM    = process.env.RESEND_FROM || 'MG Surgical Associates Calendar <onboarding@resend.dev>';
  const ADMIN_EMAIL    = process.env.ADMIN_EMAIL;
  if (!RESEND_API_KEY || !ADMIN_EMAIL) return;

  const subject = `[Team Cal] ${memberName} requested ${days} day${days === 1 ? '' : 's'} of ${typeLabel} (${range})`;
  const inter = "'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
  const serif = "'Source Serif 4',Georgia,serif";
  const ink='#1a2a33', ink2='#3a4a52', muted='#6b7780', accent='#1f6b6b', line='rgba(26,42,51,0.14)';
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#e8e6e1;font-family:${inter};color:${ink};">
<table width="100%" cellspacing="0" cellpadding="0" style="background:#e8e6e1;padding:32px 16px;"><tr><td align="center">
<table width="560" cellspacing="0" cellpadding="0" style="background:#fff;max-width:560px;border-radius:2px;box-shadow:0 8px 32px rgba(0,0,0,0.12);">
<tr><td style="padding:28px 32px 24px;">
<div style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:${accent};font-weight:600;margin-bottom:6px;">MG Surgical Associates · New Request</div>
<div style="font-family:${serif};font-size:22px;font-weight:600;color:${ink};letter-spacing:-0.005em;margin:0 0 4px;">${escapeHtml(memberName)} requested ${escapeHtml(typeLabel)}</div>
<div style="font-size:12px;color:${muted};margin-bottom:18px;">A new time-away request is awaiting your decision.</div>
<table width="100%" cellspacing="0" cellpadding="0" style="border-top:1.5px solid ${ink};border-bottom:1.5px solid ${ink};margin-bottom:18px;">
<tr><td style="padding:14px 0 6px;vertical-align:top;">
<div style="font-size:10px;letter-spacing:0.10em;text-transform:uppercase;color:${muted};font-weight:600;margin-bottom:4px;">Days</div>
<div style="font-family:${serif};font-size:36px;font-weight:600;color:${ink};line-height:1;letter-spacing:-0.01em;">${days}</div>
</td><td style="padding:14px 0 6px;vertical-align:top;text-align:right;">
<div style="font-size:10px;letter-spacing:0.10em;text-transform:uppercase;color:${muted};font-weight:600;margin-bottom:4px;">Type</div>
<div style="font-family:${serif};font-size:18px;font-weight:600;color:${accent};line-height:1.2;">${escapeHtml(typeLabel)}</div>
</td></tr></table>
<table width="100%" cellspacing="0" cellpadding="0" style="font-size:13px;color:${ink};">
<tr><td style="padding:6px 0;border-bottom:1px solid ${line};color:${ink2};font-size:11px;letter-spacing:0.05em;text-transform:uppercase;font-weight:600;width:30%;">Member</td><td style="padding:6px 0;border-bottom:1px solid ${line};">${escapeHtml(memberName)}</td></tr>
<tr><td style="padding:6px 0;border-bottom:1px solid ${line};color:${ink2};font-size:11px;letter-spacing:0.05em;text-transform:uppercase;font-weight:600;">Range</td><td style="padding:6px 0;border-bottom:1px solid ${line};">${escapeHtml(range)}</td></tr>
<tr><td style="padding:6px 0;border-bottom:1px solid ${line};color:${ink2};font-size:11px;letter-spacing:0.05em;text-transform:uppercase;font-weight:600;">Notes</td><td style="padding:6px 0;border-bottom:1px solid ${line};color:${notes ? ink : muted};">${notes ? escapeHtml(notes) : '—'}</td></tr>
</table>
<div style="margin-top:20px;padding-top:14px;border-top:1px solid ${line};font-size:11px;color:${muted};letter-spacing:0.04em;">Sign in to the calendar and use the admin panel to approve, deny, or override.</div>
</td></tr></table>
<div style="font-size:10px;color:${muted};letter-spacing:0.04em;margin-top:14px;">MG Surgical Associates · Calendar</div>
</td></tr></table></body></html>`;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: RESEND_FROM, to: [ADMIN_EMAIL], subject, html }),
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// Types a member may act on themselves. Sick / FMLA / swaps are
// admin-managed and stay off this list.
const MEMBER_WITHDRAW_TYPES = ['pto', 'cme', 'taw'];

// Shared ownership / type checks for the three member-initiated actions.
async function loadOwnEntry(supa, member, id, res) {
  if (!id) { send(res, 400, { error: 'missing_id' }); return null; }
  const { data: entry, error } = await supa
    .from('calendar_entries')
    .select('id, member_id, event_type, start_date, end_date, status, removal_requested_at')
    .eq('id', id)
    .maybeSingle();
  if (error) { console.error('own entry fetch', error); send(res, 500, { error: 'server_error' }); return null; }
  if (!entry) { send(res, 404, { error: 'not_found' }); return null; }
  if (entry.member_id !== member.id) { send(res, 403, { error: 'not_your_entry' }); return null; }
  if (!MEMBER_WITHDRAW_TYPES.includes(entry.event_type)) {
    send(res, 400, { error: 'not_withdrawable', detail: 'This entry type can only be adjusted by Admin.' });
    return null;
  }
  return entry;
}

// Ask to cancel APPROVED time away. Flags the entry rather than deleting it,
// so Admin sees every cancellation and the day stays accounted for until they
// decide. Replaces the old ">14 days out, delete it yourself" rule — that let
// far-out cancellations happen unseen while blocking near-term ones entirely,
// which is backwards: the near-term ones are exactly the ones Admin needs to
// know about, and there's no risk in letting someone ASK about next week.
async function handleRequestRemoval(supa, member, body, res) {
  const entry = await loadOwnEntry(supa, member, body?.id, res);
  if (!entry) return;

  if (entry.status !== 'approved') {
    return send(res, 400, {
      error: 'not_approved',
      detail: 'Only approved time away needs a removal request — withdraw it directly instead.',
    });
  }
  if (entry.removal_requested_at) {
    return send(res, 409, { error: 'already_requested', detail: 'You already asked to remove this. Admin will review it.' });
  }
  const reason = (typeof body?.reason === 'string') ? body.reason.trim() : '';
  if (!reason) {
    return send(res, 400, { error: 'reason_required', detail: 'Add a short reason so Admin knows why.' });
  }

  const { data, error } = await supa
    .from('calendar_entries')
    .update({ removal_requested_at: new Date().toISOString(), removal_reason: reason.slice(0, 500) })
    .eq('id', entry.id)
    .select('*')
    .single();
  if (error) { console.error('request removal', error); return send(res, 500, { error: 'server_error' }); }

  const typeLabel = TYPE_LABEL[entry.event_type] || entry.event_type;
  const range = formatRange(entry.start_date, entry.end_date);
  const { count: pendingCount } = await supa
    .from('calendar_entries').select('id', { count: 'exact', head: true }).eq('status', 'pending');
  sendPush({
    recipientType: 'admin',
    payload: {
      title: `${member.name} wants to cancel ${typeLabel}`,
      body: `${range} — "${reason.length > 80 ? reason.slice(0, 77) + '…' : reason}"`,
      tag: `rmreq-${entry.id}`,
      entryId: entry.id,
      url: `/index.html?entry=${entry.id}`,
      badge_count: (pendingCount ?? 0) + 1,
    },
  }).catch(err => console.error('push removal request', err));

  return send(res, 200, { entry: data, removal_requested: true });
}

// Member changed their mind before Admin decided — clears the flag.
async function handleCancelRemoval(supa, member, body, res) {
  const entry = await loadOwnEntry(supa, member, body?.id, res);
  if (!entry) return;
  if (!entry.removal_requested_at) {
    return send(res, 400, { error: 'no_request', detail: 'There is no removal request on this entry.' });
  }
  const { data, error } = await supa
    .from('calendar_entries')
    .update({ removal_requested_at: null, removal_reason: null })
    .eq('id', entry.id)
    .select('*')
    .single();
  if (error) { console.error('cancel removal', error); return send(res, 500, { error: 'server_error' }); }

  const typeLabel = TYPE_LABEL[entry.event_type] || entry.event_type;
  sendPush({
    recipientType: 'admin',
    payload: {
      title: `${member.name} called off their cancellation`,
      body: `${typeLabel} ${formatRange(entry.start_date, entry.end_date)} stands as approved`,
      tag: `rmreq-${entry.id}`,
    },
  }).catch(err => console.error('push cancel removal', err));

  return send(res, 200, { entry: data, removal_cancelled: true });
}

// Retract a request that hasn't been decided yet. Nothing has been planned
// around a pending entry, so this still deletes outright — but Admin is
// notified, so no cancellation happens unseen. Cancelling APPROVED time away
// goes through handleRequestRemoval instead.
async function handleWithdraw(supa, member, body, res) {
  const entry = await loadOwnEntry(supa, member, body?.id, res);
  if (!entry) return;
  const id = entry.id;

  if (entry.status === 'approved') {
    return send(res, 400, {
      error: 'already_approved',
      detail: 'This time away was approved — ask Admin to remove it instead.',
    });
  }

  const { error: delError } = await supa.from('calendar_entries').delete().eq('id', id);
  if (delError) { console.error('withdraw delete', delError); return send(res, 500, { error: 'server_error' }); }

  // Fire-and-forget admin notification so you know when someone cancels a
  // pre-planned request without having to check the calendar.
  const typeLabel = TYPE_LABEL[entry.event_type] || entry.event_type;
  const range = formatRange(entry.start_date, entry.end_date);
  sendPush({
    recipientType: 'admin',
    payload: {
      title: `${member.name} withdrew ${typeLabel}`,
      body: `${range} — pulled before it was decided`,
      tag: `withdraw-${id}`,
    },
  }).catch(err => console.error('push withdraw', err));

  return send(res, 200, { ok: true, withdrawn: true });
}
