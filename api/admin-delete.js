import { serviceClient, readJson, send, methodGuard, verifyAdminToken } from './_lib.js';

// POST { token, id } → delete an entry.
export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;
  const body = await readJson(req);
  if (!verifyAdminToken(body?.token)) return send(res, 401, { error: 'unauthorized' });

  const { id } = body || {};
  if (!id) return send(res, 400, { error: 'missing_id' });

  try {
    const supa = serviceClient();
    const { error } = await supa.from('calendar_entries').delete().eq('id', id);
    if (error) throw error;
    return send(res, 200, { ok: true });
  } catch (err) {
    console.error('admin-delete', err);
    return send(res, 500, { error: 'server_error' });
  }
}
