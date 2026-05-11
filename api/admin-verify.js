import crypto from 'node:crypto';
import { readJson, send, methodGuard, mintAdminToken, serviceClient } from './_lib.js';

// Two ways to mint an admin token:
//   1. POST { password }      → token if password matches ADMIN_PASSWORD
//   2. POST {} with `Authorization: Bearer <jwt>` → token if the JWT's
//      email matches ADMIN_EMAIL (env var). Lets the designated admin
//      user auto-elevate without typing the password each session.
// Token is HMAC-SHA256(secret, "admin:" + dayNumber) — valid for ~24h.
export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;
  const body = await readJson(req);
  const password = body?.password;
  const expected = process.env.ADMIN_PASSWORD;
  const adminEmail = (process.env.ADMIN_EMAIL || '').toLowerCase();

  // Path 2: JWT-based auto-admin (only if ADMIN_EMAIL is configured).
  const auth = req.headers['authorization'] || req.headers['Authorization'] || '';
  const jwt = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (jwt && !password) {
    if (!adminEmail) return send(res, 401, { error: 'admin_email_not_set' });
    try {
      const supa = serviceClient();
      const { data, error } = await supa.auth.getUser(jwt);
      if (error || !data?.user) return send(res, 401, { error: 'invalid_token' });
      const userEmail = (data.user.email || '').toLowerCase();
      if (userEmail && userEmail === adminEmail) {
        return send(res, 200, { token: mintAdminToken(), auto: true });
      }
      return send(res, 401, { error: 'not_admin_user' });
    } catch (err) {
      console.error('admin-verify jwt path', err);
      return send(res, 500, { error: 'server_error' });
    }
  }

  // Path 1: password.
  if (!expected) {
    console.error('admin-verify: ADMIN_PASSWORD not set');
    return send(res, 500, { error: 'not_configured' });
  }
  await new Promise(r => setTimeout(r, 250));
  if (typeof password !== 'string') {
    return send(res, 400, { error: 'missing_password' });
  }
  const a = Buffer.from(password);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return send(res, 401, { error: 'invalid_password' });
  }
  return send(res, 200, { token: mintAdminToken() });
}
