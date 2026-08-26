import crypto from 'node:crypto';
import { readJson, send, methodGuard, mintAdminToken, serviceClient, isAdminRole, ROLE_LABEL } from './_lib.js';

// Mint an identity-bearing admin token. A valid Supabase JWT is REQUIRED on
// every path — the token records which admin is acting, so there is no way
// to elevate anonymously.
//
//   POST {}            + Authorization: Bearer <jwt>
//     → token if the caller's team_members.role is admin or associate_admin.
//
//   POST { password }  + Authorization: Bearer <jwt>
//     → break-glass. Correct ADMIN_PASSWORD elevates the *authenticated*
//       caller to full admin even if their role hasn't been set yet. Kept so
//       the owner can't be locked out before the role migration runs.
//
// Token is HMAC-signed over { memberId, role, day } — valid ~24h.
export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;
  const body = await readJson(req);
  const password = body?.password;

  const auth = req.headers['authorization'] || req.headers['Authorization'] || '';
  const jwt = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!jwt) return send(res, 401, { error: 'sign_in_required' });

  let supa;
  try { supa = serviceClient(); } catch (e) {
    console.error('admin-verify client', e);
    return send(res, 500, { error: 'server_error' });
  }

  let member;
  try {
    const { data, error } = await supa.auth.getUser(jwt);
    if (error || !data?.user) return send(res, 401, { error: 'invalid_token' });
    const user = data.user;

    // Two column sets: with role, and without. The second is deploy-order
    // insurance for the window before the role migration is applied —
    // otherwise elevation would fail outright and lock the owner out.
    let cols = 'id, name, email, role, active';
    let roleColumnMissing = false;

    const lookup = async () => {
      const byAuthId = await supa
        .from('team_members').select(cols).eq('auth_user_id', user.id).maybeSingle();
      if (byAuthId.error) return { error: byAuthId.error };
      if (byAuthId.data) return { data: byAuthId.data };
      if (!user.email) return { data: null };
      const byEmail = await supa
        .from('team_members').select(cols).ilike('email', user.email).maybeSingle();
      return byEmail.error ? { error: byEmail.error } : { data: byEmail.data };
    };

    let result = await lookup();
    if (result.error) {
      cols = 'id, name, email, active';
      roleColumnMissing = true;
      console.warn('[roles] role column missing — run the migration.');
      result = await lookup();
      if (result.error) throw result.error;
    }
    member = result.data;
    if (member && roleColumnMissing) member.role = 'member';
  } catch (err) {
    console.error('admin-verify lookup', err);
    return send(res, 500, { error: 'server_error' });
  }

  if (!member) return send(res, 403, { error: 'not_a_team_member' });
  if (!member.active) return send(res, 403, { error: 'inactive_member' });

  // Break-glass: correct password elevates this authenticated caller to full
  // admin. Also self-heals the owner's role so the password isn't needed again.
  if (typeof password === 'string' && password.length > 0) {
    const expected = process.env.ADMIN_PASSWORD;
    if (!expected) {
      console.error('admin-verify: ADMIN_PASSWORD not set');
      return send(res, 500, { error: 'not_configured' });
    }
    await new Promise(r => setTimeout(r, 250));
    const a = Buffer.from(password);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return send(res, 401, { error: 'invalid_password' });
    }
    if (member.role !== 'admin') {
      const { data: promoted } = await supa
        .from('team_members')
        .update({ role: 'admin' })
        .eq('id', member.id)
        .select('id, name, email, role')
        .maybeSingle();
      if (promoted) member = { ...member, ...promoted };
    }
    return send(res, 200, {
      token: mintAdminToken({ memberId: member.id, role: 'admin' }),
      role: 'admin',
      role_label: ROLE_LABEL.admin,
      name: member.name,
    });
  }

  // Standard path: role decides.
  let role = member.role;

  // Bootstrap fallback — if the role migration hasn't been applied yet, the
  // configured ADMIN_EMAIL still elevates (and gets its role written).
  const adminEmail = (process.env.ADMIN_EMAIL || '').toLowerCase();
  if (!isAdminRole(role) && adminEmail && (member.email || '').toLowerCase() === adminEmail) {
    role = 'admin';
    await supa.from('team_members').update({ role: 'admin' }).eq('id', member.id);
  }

  if (!isAdminRole(role)) return send(res, 403, { error: 'not_admin_user' });

  return send(res, 200, {
    token: mintAdminToken({ memberId: member.id, role }),
    role,
    role_label: ROLE_LABEL[role] || role,
    name: member.name,
    auto: true,
  });
}
