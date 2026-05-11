import { serviceClient, readJson, send, methodGuard, nextAvailableColor } from './_lib.js';
import { sendPush } from './_push.js';

// POST { name, email, password } → creates auth user (email-confirmed) + a
// pending team_members row. Notifies admin. Returns { session } so the
// browser can sign in immediately and land on the pending-approval screen.
export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;
  const body = await readJson(req);
  const name = (body?.name || '').trim();
  const email = (body?.email || '').trim().toLowerCase();
  const password = body?.password || '';

  if (!name || name.length < 2) return send(res, 400, { error: 'invalid_name' });
  if (!email.includes('@')) return send(res, 400, { error: 'invalid_email' });
  if (!password || password.length < 8) return send(res, 400, { error: 'invalid_password' });

  try {
    const supa = serviceClient();

    // Reject if email already exists in team_members.
    const { data: existing } = await supa
      .from('team_members')
      .select('id, active, signup_pending')
      .ilike('email', email)
      .maybeSingle();
    if (existing) {
      return send(res, 409, { error: 'already_exists' });
    }

    // Create auth user with email already confirmed (no email loop).
    const { data: created, error: createErr } = await supa.auth.admin.createUser({
      email, password, email_confirm: true,
      user_metadata: { full_name: name },
    });
    if (createErr) {
      console.error('signup createUser', createErr);
      const msg = (createErr.message || '').toLowerCase();
      if (msg.includes('already')) return send(res, 409, { error: 'already_exists' });
      return send(res, 500, { error: 'create_failed' });
    }

    const authUserId = created.user.id;
    const color = await nextAvailableColor(supa, name);

    // Create the team_members row in pending state.
    const { error: tmErr } = await supa.from('team_members').insert({
      auth_user_id: authUserId,
      name, email, color,
      active: false,
      signup_pending: true,
    });
    if (tmErr) {
      console.error('signup insert team_members', tmErr);
      // Roll back the auth user so signup can be retried.
      await supa.auth.admin.deleteUser(authUserId).catch(() => {});
      return send(res, 500, { error: 'create_failed' });
    }

    // Notify admin (push + email — fire-and-forget).
    sendPush({
      recipientType: 'admin',
      payload: {
        title: 'New team-member signup',
        body: `${name} (${email}) is awaiting approval`,
        tag: `signup-${authUserId}`,
      },
    }).catch(err => console.error('push signup', err));

    sendSignupEmail({ name, email }).catch(err => console.error('email signup', err));

    return send(res, 200, { ok: true });
  } catch (err) {
    console.error('signup-request', err);
    return send(res, 500, { error: 'server_error' });
  }
}

async function sendSignupEmail({ name, email }) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const RESEND_FROM    = process.env.RESEND_FROM || 'MGH PA Team Calendar <onboarding@resend.dev>';
  const ADMIN_EMAIL    = process.env.ADMIN_EMAIL;
  const APP_URL        = process.env.APP_URL || '';
  if (!RESEND_API_KEY || !ADMIN_EMAIL) return;

  const subject = `[Team Cal] New signup awaiting approval — ${name}`;
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#e8e6e1;font-family:Inter,sans-serif;">
    <table width="100%" cellspacing="0" cellpadding="0" style="background:#e8e6e1;padding:32px 16px;"><tr><td align="center">
    <table width="540" cellspacing="0" cellpadding="0" style="background:#fff;max-width:540px;border-radius:2px;box-shadow:0 8px 32px rgba(0,0,0,0.12);">
    <tr><td style="padding:28px 32px;">
      <div style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#1f6b6b;font-weight:600;margin-bottom:6px;">MGH Robotic Surgery PA Team · New Signup</div>
      <div style="font-family:'Source Serif 4',Georgia,serif;font-size:22px;font-weight:600;color:#1a2a33;margin:0 0 18px;">${escapeHtml(name)} requested access</div>
      <table width="100%" cellspacing="0" cellpadding="0" style="font-size:13px;color:#1a2a33;">
        <tr><td style="padding:6px 0;border-bottom:1px solid rgba(26,42,51,0.14);color:#3a4a52;font-size:11px;letter-spacing:0.05em;text-transform:uppercase;font-weight:600;width:30%;">Name</td><td style="padding:6px 0;border-bottom:1px solid rgba(26,42,51,0.14);">${escapeHtml(name)}</td></tr>
        <tr><td style="padding:6px 0;border-bottom:1px solid rgba(26,42,51,0.14);color:#3a4a52;font-size:11px;letter-spacing:0.05em;text-transform:uppercase;font-weight:600;">Email</td><td style="padding:6px 0;border-bottom:1px solid rgba(26,42,51,0.14);">${escapeHtml(email)}</td></tr>
      </table>
      ${APP_URL ? `<div style="margin-top:18px;"><a href="${escapeHtml(APP_URL)}" style="display:inline-block;background:#1f6b6b;color:#fff;text-decoration:none;padding:10px 18px;font-size:13px;font-weight:600;letter-spacing:0.02em;border-radius:2px;">Review in Admin Panel</a></div>` : ''}
    </td></tr></table></td></tr></table></body></html>`;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: RESEND_FROM, to: [ADMIN_EMAIL], subject, html }),
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
