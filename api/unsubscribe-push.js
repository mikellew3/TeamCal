import { serviceClient, readJson, send, methodGuard } from './_lib.js';

// POST { endpoint } → remove a single push subscription. No auth required —
// knowing the endpoint is sufficient (and the browser is the only thing
// that has it for a given device).
export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;
  const { endpoint } = await readJson(req);
  if (!endpoint) return send(res, 400, { error: 'missing_endpoint' });
  try {
    const supa = serviceClient();
    const { error } = await supa.from('push_subscriptions').delete().eq('endpoint', endpoint);
    if (error) throw error;
    return send(res, 200, { ok: true });
  } catch (err) {
    console.error('unsubscribe-push', err);
    return send(res, 500, { error: 'server_error' });
  }
}
