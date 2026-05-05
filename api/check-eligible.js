import { serviceClient, readJson, send, methodGuard } from './_lib.js';

// POST { email } → { eligible: true|false }. Slowed slightly to make
// enumeration unappealing.
export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;
  const { email } = await readJson(req);
  if (typeof email !== 'string' || !email.includes('@')) {
    return send(res, 400, { error: 'invalid_email' });
  }
  await new Promise(r => setTimeout(r, 300));
  try {
    const supa = serviceClient();
    const { data, error } = await supa
      .from('team_members')
      .select('id')
      .ilike('email', email.trim())
      .eq('active', true)
      .limit(1);
    if (error) throw error;
    return send(res, 200, { eligible: !!(data && data.length) });
  } catch (e) {
    console.error('check-eligible', e);
    return send(res, 500, { error: 'server_error' });
  }
}
