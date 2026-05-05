import crypto from 'node:crypto';
import { readJson, send, methodGuard, mintAdminToken } from './_lib.js';

// POST { password } → { token } if password matches ADMIN_PASSWORD.
// Token is HMAC-SHA256(secret, "admin:" + dayNumber) — valid for ~24h.
export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;
  const { password } = await readJson(req);
  const expected = process.env.ADMIN_PASSWORD;
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
