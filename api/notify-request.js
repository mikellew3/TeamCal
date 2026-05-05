import { serviceClient, readJson, send, methodGuard, categoryFor } from './_lib.js';

const TYPE_LABELS = {
  pto: 'PTO', cme: 'CME', pd: 'PD',
  note: 'Note', onb: 'Onboarding', shd: 'Shadowing',
  per_diem: 'Per Diem', swp: 'Swap',
};

// POST { entry_id } → send admin notification email via Resend.
// Silent no-op if RESEND_API_KEY is not set.
export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;
  const { entry_id } = await readJson(req);
  if (!entry_id) return send(res, 400, { error: 'missing_entry_id' });

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const RESEND_FROM    = process.env.RESEND_FROM || 'MGH PA Team Calendar <onboarding@resend.dev>';
  const ADMIN_EMAIL    = process.env.ADMIN_EMAIL;

  if (!RESEND_API_KEY || !ADMIN_EMAIL) {
    return send(res, 200, { sent: false, reason: 'not_configured' });
  }

  try {
    const supa = serviceClient();
    const { data: entry, error } = await supa
      .from('calendar_entries')
      .select('*, team_members(name, email)')
      .eq('id', entry_id)
      .maybeSingle();
    if (error || !entry) return send(res, 404, { error: 'entry_not_found' });

    const memberName = entry.team_members?.name || 'Someone';
    const typeLabel = TYPE_LABELS[entry.event_type] || entry.event_type;
    const days = dayCount(entry.start_date, entry.end_date);
    const range = entry.start_date === entry.end_date
      ? formatDate(entry.start_date)
      : `${formatDate(entry.start_date)} – ${formatDate(entry.end_date)}`;

    const subject = `[Team Cal] ${memberName} requested ${days} day${days === 1 ? '' : 's'} of ${typeLabel} (${range})`;
    const html = renderEmail({ memberName, typeLabel, days, range, notes: entry.notes });

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [ADMIN_EMAIL],
        subject,
        html,
      }),
    });
    if (!r.ok) {
      const text = await r.text();
      console.error('Resend API error', r.status, text);
      return send(res, 500, { error: 'send_failed' });
    }
    return send(res, 200, { sent: true });
  } catch (err) {
    console.error('notify-request', err);
    return send(res, 500, { error: 'server_error' });
  }
}

function dayCount(start, end) {
  const a = new Date(`${start}T00:00:00Z`);
  const b = new Date(`${end}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000) + 1;
}

function formatDate(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Inline-styled HTML email matching the report's visual language.
function renderEmail({ memberName, typeLabel, days, range, notes }) {
  const inter = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  const serif = "'Source Serif 4', Georgia, serif";
  const ink = '#1a2a33';
  const ink2 = '#3a4a52';
  const muted = '#6b7780';
  const accent = '#1f6b6b';
  const line = 'rgba(26,42,51,0.14)';
  const paperWarm = '#fafaf7';

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#e8e6e1;font-family:${inter};color:${ink};-webkit-font-smoothing:antialiased;">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Source+Serif+4:wght@500;600&display=swap">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#e8e6e1;padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0" style="background:#fff;max-width:560px;border-radius:2px;box-shadow:0 8px 32px rgba(0,0,0,0.12);">
      <tr><td style="padding:28px 32px 24px;">
        <div style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:${accent};font-weight:600;margin-bottom:6px;">MGH Robotic Surgery PA Team · New Request</div>
        <div style="font-family:${serif};font-size:22px;font-weight:600;color:${ink};letter-spacing:-0.005em;margin:0 0 4px;">${escapeHtml(memberName)} requested ${typeLabel}</div>
        <div style="font-size:12px;color:${muted};margin-bottom:18px;">A new time-away request is awaiting your decision.</div>

        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-top:1.5px solid ${ink};border-bottom:1.5px solid ${ink};margin-bottom:18px;">
          <tr><td style="padding:14px 0 6px;vertical-align:top;">
            <div style="font-size:10px;letter-spacing:0.10em;text-transform:uppercase;color:${muted};font-weight:600;margin-bottom:4px;">Days</div>
            <div style="font-family:${serif};font-size:36px;font-weight:600;color:${ink};line-height:1;letter-spacing:-0.01em;">${days}</div>
          </td>
          <td style="padding:14px 0 6px;vertical-align:top;text-align:right;">
            <div style="font-size:10px;letter-spacing:0.10em;text-transform:uppercase;color:${muted};font-weight:600;margin-bottom:4px;">Type</div>
            <div style="font-family:${serif};font-size:18px;font-weight:600;color:${accent};line-height:1.2;">${typeLabel}</div>
          </td></tr>
        </table>

        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="font-size:13px;color:${ink};">
          <tr><td style="padding:6px 0;border-bottom:1px solid ${line};color:${ink2};font-size:11px;letter-spacing:0.05em;text-transform:uppercase;font-weight:600;width:30%;">Member</td><td style="padding:6px 0;border-bottom:1px solid ${line};">${escapeHtml(memberName)}</td></tr>
          <tr><td style="padding:6px 0;border-bottom:1px solid ${line};color:${ink2};font-size:11px;letter-spacing:0.05em;text-transform:uppercase;font-weight:600;">Range</td><td style="padding:6px 0;border-bottom:1px solid ${line};">${escapeHtml(range)}</td></tr>
          <tr><td style="padding:6px 0;border-bottom:1px solid ${line};color:${ink2};font-size:11px;letter-spacing:0.05em;text-transform:uppercase;font-weight:600;">Notes</td><td style="padding:6px 0;border-bottom:1px solid ${line};color:${notes ? ink : muted};">${notes ? escapeHtml(notes) : '—'}</td></tr>
        </table>

        <div style="margin-top:20px;padding-top:14px;border-top:1px solid ${line};font-size:11px;color:${muted};letter-spacing:0.04em;">
          Sign in to the calendar and use the admin panel to approve, deny, or override.
        </div>
      </td></tr>
    </table>
    <div style="font-size:10px;color:${muted};letter-spacing:0.04em;margin-top:14px;">MGH Robotic Surgery PA Team · Calendar</div>
  </td></tr>
</table>
</body></html>`;
}
