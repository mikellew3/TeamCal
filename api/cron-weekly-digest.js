import { serviceClient, TYPE_LABEL, TIME_AWAY_TYPES } from './_lib.js';

// Vercel Cron entry: 0 1 * * 1  (01:00 UTC every Monday = Sunday ~8 PM ET).
// Vercel automatically attaches `Authorization: Bearer ${CRON_SECRET}` to
// scheduled invocations. We require it to make manual hits (or other
// bots scanning the path) inert.
//
// Behavior:
//   1. Compute the upcoming Mon–Sun window in America/New_York.
//   2. Pull all approved entries that overlap that window.
//   3. Per-member: send a personalized digest if they have ≥1 entry.
//   4. Admin: always send a master summary including coverage warnings.

export default async function handler(req, res) {
  // Auth — accept either Vercel's automatic header OR a manual call with
  // ?key=CRON_SECRET (handy for testing).
  const auth = req.headers['authorization'] || '';
  const expected = process.env.CRON_SECRET;
  const queryKey = (req.url || '').split('?')[1]
    ? Object.fromEntries(new URLSearchParams(req.url.split('?')[1])).key
    : undefined;
  const ok = expected
    && (auth === `Bearer ${expected}` || queryKey === expected);
  if (!ok) {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const RESEND_FROM    = process.env.RESEND_FROM || 'PA Calendar <onboarding@resend.dev>';
  const ADMIN_EMAIL    = process.env.ADMIN_EMAIL;
  const APP_URL        = process.env.APP_URL || '';

  if (!RESEND_API_KEY) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ skipped: true, reason: 'RESEND_API_KEY not set' }));
    return;
  }

  try {
    const supa = serviceClient();
    const { monday, sunday } = upcomingEtWeek(new Date());

    const { data: entries, error } = await supa
      .from('calendar_entries')
      .select('*, team_members(id, name, email, color, active)')
      .eq('status', 'approved')
      .lte('start_date', sunday)
      .gte('end_date', monday)
      .order('start_date');
    if (error) throw error;

    const { data: members } = await supa
      .from('team_members')
      .select('id, name, email, active')
      .eq('active', true);

    // Group by member for personal digests.
    const byMember = new Map();
    for (const e of entries || []) {
      if (!e.member_id) continue;
      if (!byMember.has(e.member_id)) byMember.set(e.member_id, []);
      byMember.get(e.member_id).push(e);
    }

    const sends = [];
    const rangeLabel = `${formatLong(monday)} – ${formatLong(sunday)}`;

    for (const member of (members || [])) {
      const memberEntries = byMember.get(member.id) || [];
      if (!memberEntries.length) continue;
      sends.push(sendEmail({
        apiKey: RESEND_API_KEY, from: RESEND_FROM,
        to: member.email,
        subject: `Your week ahead — ${rangeLabel}`,
        html: renderMemberDigest({ member, entries: memberEntries, monday, sunday, rangeLabel, appUrl: APP_URL }),
      }));
    }

    if (ADMIN_EMAIL) {
      sends.push(sendEmail({
        apiKey: RESEND_API_KEY, from: RESEND_FROM,
        to: ADMIN_EMAIL,
        subject: `Team week ahead — ${rangeLabel}`,
        html: renderAdminDigest({ entries: entries || [], monday, sunday, rangeLabel, appUrl: APP_URL }),
      }));
    }

    const results = await Promise.allSettled(sends);
    const sent = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.length - sent;
    if (failed > 0) console.error('digest failures', results.filter(r => r.status === 'rejected').map(r => r.reason));

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, week: rangeLabel, sent, failed, members_emailed: sends.length - (ADMIN_EMAIL ? 1 : 0) }));
  } catch (err) {
    console.error('cron-weekly-digest', err);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'server_error', detail: String(err?.message || err) }));
  }
}

// --------------------------------------------------------------
// Eastern-Time week math. Returns the YYYY-MM-DD strings for the
// Monday and Sunday of the WEEK FOLLOWING `now` in America/New_York.
// If `now` is Sunday evening in ET, this returns the upcoming Mon–Sun.
// --------------------------------------------------------------
function upcomingEtWeek(now) {
  // Get the current weekday in ET (Sun=0..Sat=6).
  const etParts = etDateParts(now);
  // Find next Monday in ET. If today is Monday in ET we still want
  // the *upcoming* Monday — but since the cron runs Sunday evening ET
  // (Monday 01:00 UTC), "today in ET" is Sunday and the next Monday is
  // in ~5 hours. Build it explicitly from etParts.
  // Days until next Monday from today's ET weekday (1 == Monday):
  const daysToMon = (1 - etParts.dow + 7) % 7 || 7;
  // If we're literally on Monday already in ET, daysToMon would be 7
  // (next Mon), which is what we want — except in the Sunday-evening
  // case we computed above where dow=0 → daysToMon=1.
  const monday = addDaysToYmd(`${etParts.y}-${pad(etParts.m)}-${pad(etParts.d)}`, daysToMon);
  const sunday = addDaysToYmd(monday, 6);
  return { monday, sunday };
}

function etDateParts(date) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  });
  const parts = fmt.formatToParts(date);
  const get = (t) => parts.find(p => p.type === t)?.value;
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    y: Number(get('year')),
    m: Number(get('month')),
    d: Number(get('day')),
    dow: dowMap[get('weekday')],
  };
}

function pad(n) { return String(n).padStart(2, '0'); }

function addDaysToYmd(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function expandDays(start, end) {
  const out = [];
  let d = start;
  while (d <= end) {
    out.push(d);
    d = addDaysToYmd(d, 1);
  }
  return out;
}

function formatLong(ymd) {
  return new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-US',
    { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
function formatDayLabel(ymd) {
  return new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-US',
    { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]
  ));
}

function typeColor(et) {
  if (TIME_AWAY_TYPES.includes(et)) return '#1f6b6b';
  if (['per_diem', 'swp'].includes(et)) return '#3a4a7a';
  return '#6b4a1f';
}

async function sendEmail({ apiKey, from, to, subject, html }) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to: [to], subject, html }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Resend ${r.status}: ${t}`);
  }
  return r.json();
}

// --------------------------------------------------------------
// EMAIL TEMPLATES — inline styles only, NO <style> blocks.
// --------------------------------------------------------------
function renderMemberDigest({ member, entries, monday, sunday, rangeLabel, appUrl }) {
  const days = expandDays(monday, sunday);
  const byDay = new Map(days.map(d => [d, []]));
  for (const e of entries) {
    for (const day of days) {
      if (day >= e.start_date && day <= e.end_date) byDay.get(day).push(e);
    }
  }

  const blocks = days
    .filter(d => byDay.get(d).length)
    .map(d => dayBlockHtml(d, byDay.get(d), { showNotes: true }))
    .join('');

  const total = entries.length;
  const intro = `<p style="font-size:14px;line-height:1.5;color:#1a2a33;margin:0 0 16px;">You have ${total} ${total === 1 ? 'entry' : 'entries'} scheduled this week.</p>`;
  const cta = appUrl ? ctaHtml(appUrl) : '';

  return wrapHtml({
    eyebrow: 'MGH PA Team Calendar — Weekly Digest',
    h1: `Your week ahead`,
    sub: rangeLabel,
    body: intro + blocks + cta,
    footer: 'MGH Robotic Surgery PA Team · Calendar<br/>Reply to this email to reach the program lead',
  });
}

function renderAdminDigest({ entries, monday, sunday, rangeLabel, appUrl }) {
  const days = expandDays(monday, sunday);
  const byDay = new Map(days.map(d => [d, []]));
  for (const e of entries) {
    if (!e.member_id) continue;
    for (const day of days) {
      if (day >= e.start_date && day <= e.end_date) byDay.get(day).push(e);
    }
  }

  // Heads-up: any day with 2+ Time Away members off.
  const headsUp = [];
  for (const day of days) {
    const list = byDay.get(day).filter(e => TIME_AWAY_TYPES.includes(e.event_type));
    const distinct = new Map();
    for (const e of list) {
      if (!distinct.has(e.member_id)) {
        distinct.set(e.member_id, { name: e.team_members?.name || 'Unknown', type: TYPE_LABEL[e.event_type] || e.event_type });
      }
    }
    if (distinct.size >= 2) {
      const items = Array.from(distinct.values()).map(v => `${escapeHtml(v.name)} (${v.type})`).join(', ');
      headsUp.push(`<li>${escapeHtml(formatDayLabel(day))}: ${distinct.size} people off — ${items}</li>`);
    }
  }
  const headsUpHtml = headsUp.length ? `
    <div style="background:#f5ecd9;border-left:3px solid #b8801f;padding:12px 14px;margin-bottom:16px;border-radius:2px;">
      <div style="font-family:'Source Serif 4','Georgia',serif;font-size:14px;font-weight:600;color:#8b6010;margin-bottom:6px;">Heads up</div>
      <ul style="margin:0;padding-left:18px;font-size:12px;line-height:1.5;color:#8b6010;">${headsUp.join('')}</ul>
    </div>` : '';

  const dayHeader = `<div style="font-family:'Source Serif 4','Georgia',serif;font-size:16px;font-weight:600;color:#1a2a33;margin:14px 0 6px;border-top:1.5px solid #1a2a33;padding-top:10px;">Day-by-day</div>`;

  const blocks = days.map(d => {
    const list = byDay.get(d);
    if (!list.length) {
      return `
        <div style="border-top:1px solid rgba(26,42,51,0.14);padding:10px 0;">
          <div style="font-family:'Source Serif 4','Georgia',serif;font-size:14px;font-weight:600;color:#1a2a33;margin-bottom:4px;">${escapeHtml(formatDayLabel(d))}</div>
          <div style="font-size:12px;color:#6b7780;font-style:italic;">No entries</div>
        </div>`;
    }
    return dayBlockHtml(d, list, { showNotes: true, includeMember: true });
  }).join('');

  const cta = appUrl ? ctaHtml(appUrl) : '';
  return wrapHtml({
    eyebrow: 'MGH PA Team Calendar — Admin Summary',
    h1: 'Team week ahead',
    sub: rangeLabel,
    body: headsUpHtml + dayHeader + blocks + cta,
    footer: 'MGH Robotic Surgery PA Team · Admin Digest<br/>Auto-sent every Sunday 8 PM ET',
  });
}

function dayBlockHtml(day, entries, { showNotes, includeMember = false }) {
  const rows = entries.map(e => {
    const tag = (TYPE_LABEL[e.event_type] || e.event_type).toUpperCase();
    const color = typeColor(e.event_type);
    const memberPart = includeMember && e.team_members?.name ? `${escapeHtml(e.team_members.name)} · ` : '';
    const titlePart = e.title ? escapeHtml(e.title) : (e.team_members?.name && !includeMember ? escapeHtml(e.team_members.name) : '');
    const linkRow = e.conference_link ? `<div style="font-size:12px;color:#3a4a52;margin-top:2px;">Conference: <a href="${escapeHtml(e.conference_link)}" style="color:#1f6b6b;text-decoration:underline;">${escapeHtml(e.conference_link)}</a></div>` : '';
    const noteRow = (showNotes && e.notes) ? `<div style="font-size:12px;color:#6b7780;margin-top:2px;">Notes: ${escapeHtml(e.notes)}</div>` : '';
    return `
      <tr>
        <td style="padding:6px 0;color:${color};font-weight:600;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;width:80px;vertical-align:top;">${tag}</td>
        <td style="padding:6px 0;">
          <div style="font-weight:500;color:#1a2a33;">${memberPart}${titlePart || '&nbsp;'}</div>
          ${linkRow}
          ${noteRow}
        </td>
      </tr>`;
  }).join('');

  return `
    <div style="border-top:1px solid rgba(26,42,51,0.14);padding:10px 0;">
      <div style="font-family:'Source Serif 4','Georgia',serif;font-size:14px;font-weight:600;color:#1a2a33;margin-bottom:4px;">${escapeHtml(formatDayLabel(day))}</div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">${rows}</table>
    </div>`;
}

function ctaHtml(appUrl) {
  return `
    <div style="margin:22px 0 4px;">
      <a href="${escapeHtml(appUrl)}" style="display:inline-block;background:#1f6b6b;color:#ffffff;text-decoration:none;padding:11px 20px;font-size:13px;font-weight:600;letter-spacing:0.02em;border-radius:2px;">Open Calendar →</a>
    </div>`;
}

function wrapHtml({ eyebrow, h1, sub, body, footer }) {
  const inter = "'Inter','Segoe UI',-apple-system,BlinkMacSystemFont,sans-serif";
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#e8e6e1;font-family:${inter};">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#e8e6e1;padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" width="580" cellspacing="0" cellpadding="0" border="0" style="background:#ffffff;max-width:580px;border:1px solid rgba(26,42,51,0.14);border-radius:2px;">
      <tr><td style="padding:28px 32px 24px;">
        <div style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#1f6b6b;font-weight:600;margin-bottom:6px;">${escapeHtml(eyebrow)}</div>
        <h1 style="font-family:'Source Serif 4','Georgia',serif;font-size:24px;font-weight:600;margin:0 0 4px;letter-spacing:-0.005em;color:#1a2a33;">${escapeHtml(h1)}</h1>
        <div style="font-size:13px;color:#6b7780;margin-bottom:18px;">${escapeHtml(sub)}</div>
        ${body}
        <div style="margin-top:20px;padding-top:12px;border-top:1px solid rgba(26,42,51,0.14);font-size:10px;letter-spacing:0.04em;color:#6b7780;">${footer}</div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}
