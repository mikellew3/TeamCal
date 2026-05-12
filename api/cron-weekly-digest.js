import { serviceClient, TYPE_LABEL, TIME_AWAY_TYPES } from './_lib.js';
import { sendPush } from './_push.js';

// Sunday-evening week-ahead push.
// Vercel Cron entry: 0 1 * * 1  (01:00 UTC every Monday = Sunday ~8 PM ET).
// Vercel automatically attaches Authorization: Bearer ${CRON_SECRET} on
// scheduled invocations; we require it so manual hits / bot scans are inert.
//
// Behavior:
//   1. Compute the upcoming Mon–Sun window in America/New_York.
//   2. Pull all approved entries that overlap that window.
//   3. Push a concise summary to every member with ≥1 entry that week.
//   4. Push a team total to admin devices.
// Members with no entries are skipped — no point pinging an empty week.
export default async function handler(req, res) {
  const auth = req.headers['authorization'] || '';
  const expected = process.env.CRON_SECRET;
  const queryKey = (req.url || '').split('?')[1]
    ? Object.fromEntries(new URLSearchParams(req.url.split('?')[1])).key
    : undefined;
  const ok = expected && (auth === `Bearer ${expected}` || queryKey === expected);
  if (!ok) {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  try {
    const supa = serviceClient();
    const { monday, sunday } = upcomingEtWeek(new Date());

    const { data: entries, error } = await supa
      .from('calendar_entries')
      .select('id, member_id, event_type, title, start_date, end_date, team_members(id, name)')
      .eq('status', 'approved')
      .lte('start_date', sunday)
      .gte('end_date', monday)
      .order('start_date');
    if (error) throw error;

    const { data: members } = await supa
      .from('team_members')
      .select('id, name, active')
      .eq('active', true);

    // Group entries by member for personal pushes.
    const byMember = new Map();
    for (const e of entries || []) {
      if (!e.member_id) continue;
      if (!byMember.has(e.member_id)) byMember.set(e.member_id, []);
      byMember.get(e.member_id).push(e);
    }

    const rangeLabel = `${formatShort(monday)}–${formatShort(sunday)}`;
    const sends = [];

    for (const member of (members || [])) {
      const memberEntries = byMember.get(member.id) || [];
      if (!memberEntries.length) continue;
      const summary = memberSummary(memberEntries);
      sends.push(sendPush({
        recipientType: 'member',
        memberId: member.id,
        payload: {
          title: `Week ahead — ${rangeLabel}`,
          body: summary,
          tag: `digest-${monday}-${member.id}`,
          url: '/index.html',
          badge_count: memberEntries.length,
        },
      }));
    }

    const teamTotal = (entries || []).length;
    if (teamTotal > 0) {
      sends.push(sendPush({
        recipientType: 'admin',
        payload: {
          title: `Team week ahead — ${rangeLabel}`,
          body: `${teamTotal} approved entr${teamTotal === 1 ? 'y' : 'ies'} on the schedule. Tap to review.`,
          tag: `digest-admin-${monday}`,
          url: '/index.html',
          badge_count: teamTotal,
        },
      }));
    }

    const results = await Promise.allSettled(sends);
    const failed = results.filter(r => r.status === 'rejected');
    if (failed.length) console.error('digest push failures', failed.map(r => r.reason));

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      ok: true,
      week: rangeLabel,
      member_pushes: sends.length - (teamTotal > 0 ? 1 : 0),
      admin_push: teamTotal > 0,
      failed: failed.length,
    }));
  } catch (err) {
    console.error('cron-weekly-digest', err);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'server_error', detail: String(err?.message || err) }));
  }
}

// ---- Message composition ----------------------------------------

function memberSummary(memberEntries) {
  // Sort by start date, then by event_type for stability.
  const sorted = [...memberEntries].sort((a, b) =>
    a.start_date.localeCompare(b.start_date) || a.event_type.localeCompare(b.event_type)
  );
  const parts = sorted.map(formatEntry).filter(Boolean);
  return parts.join(', ');
}

function formatEntry(e) {
  const isRange = e.end_date > e.start_date;
  const dayRange = isRange
    ? `${shortDow(e.start_date)}–${shortDow(e.end_date)}`
    : shortDow(e.start_date);

  // Time-away types: just label + day range. CME/PTO/General/etc.
  if (TIME_AWAY_TYPES.includes(e.event_type)) {
    const label = TYPE_LABEL[e.event_type] || e.event_type;
    return `${label} ${dayRange}`;
  }

  // Coverage types: include site suffix from the title if it's there.
  const title = e.title || '';
  const siteMatch = title.match(/ @ (MGH|Waltham)$/);
  const site = siteMatch ? siteMatch[1] : '';
  // Generic 'cov' and 'taw' (handled above) don't carry a tag in the chip.
  const tagless = e.event_type === 'cov';
  const tag = tagless ? '' : (TYPE_LABEL[e.event_type] || '');
  const base = tag ? `${tag} ${dayRange}` : dayRange;
  return site ? `${base} @ ${site}` : base;
}

function shortDow(ymd) {
  return new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
}

function formatShort(ymd) {
  return new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// ---- Eastern-Time week math --------------------------------------
// Returns YYYY-MM-DD strings for the Monday and Sunday of the WEEK
// FOLLOWING `now` in America/New_York. The cron fires Sunday ~8pm ET.
function upcomingEtWeek(now) {
  const etParts = etDateParts(now);
  const daysToMon = (1 - etParts.dow + 7) % 7 || 7;
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
