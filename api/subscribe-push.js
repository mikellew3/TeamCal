import {
  serviceClient, readJson, send, methodGuard, verifyAdminToken,
} from './_lib.js';

// POST { subscription, scope } where scope is 'member' or 'admin'.
// Member scope requires Authorization: Bearer <jwt>.
// Admin scope requires { admin_token }.
export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;

  const body = await readJson(req);
  const sub = body?.subscription;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    return send(res, 400, { error: 'invalid_subscription' });
  }

  const ua = (req.headers['user-agent'] || '').slice(0, 256);
  const supa = serviceClient();

  let memberId = null;
  let isAdmin = false;

  if (body?.scope === 'admin') {
    if (!verifyAdminToken(body?.admin_token)) return send(res, 401, { error: 'unauthorized' });
    isAdmin = true;
  } else {
    const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
    const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!jwt) return send(res, 401, { error: 'missing_token' });
    const { data: userData, error } = await supa.auth.getUser(jwt);
    if (error || !userData?.user) return send(res, 401, { error: 'invalid_token' });
    const member = await resolveMember(supa, userData.user);
    if (!member) return send(res, 403, { error: 'not_a_team_member' });
    memberId = member.id;
    // Dual-flag the row when the subscriber is also the admin so they
    // receive admin pings (new requests) alongside their own member pings.
    const adminEmail = (process.env.ADMIN_EMAIL || '').toLowerCase();
    const userEmail  = (userData.user.email || '').toLowerCase();
    if (adminEmail && userEmail && userEmail === adminEmail) isAdmin = true;
  }

  // Upsert by endpoint (one row per device).
  const { data, error } = await supa
    .from('push_subscriptions')
    .upsert({
      endpoint: sub.endpoint,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
      member_id: memberId,
      is_admin: isAdmin,
      user_agent: ua,
      last_used_at: new Date().toISOString(),
    }, { onConflict: 'endpoint' })
    .select('id, member_id, is_admin')
    .single();
  if (error) {
    console.error('subscribe-push', error);
    return send(res, 500, { error: 'server_error' });
  }
  return send(res, 200, {
    id: data.id,
    is_admin: data.is_admin,
    member_id: data.member_id,
    admin_email_configured: !!process.env.ADMIN_EMAIL,
  });
}

async function resolveMember(supa, user) {
  let { data } = await supa
    .from('team_members')
    .select('id, name, email, active')
    .eq('auth_user_id', user.id)
    .maybeSingle();
  if (!data && user.email) {
    const fb = await supa
      .from('team_members')
      .select('id, name, email, active')
      .ilike('email', user.email)
      .maybeSingle();
    if (fb.data) data = fb.data;
  }
  if (data && data.active === false) return null;
  return data;
}
