import { serviceClient, readJson, send, methodGuard, verifyAdminToken } from './_lib.js';

// POST { token } → { members: [...] } including pending and inactive.
export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;
  const body = await readJson(req);
  if (!verifyAdminToken(body?.token)) return send(res, 401, { error: 'unauthorized' });

  try {
    const supa = serviceClient();
    const { data, error } = await supa
      .from('team_members')
      .select('id, name, email, color, active, signup_pending, auth_user_id, created_at')
      .order('signup_pending', { ascending: false })
      .order('active', { ascending: false })
      .order('name', { ascending: true });
    if (error) throw error;
    return send(res, 200, { members: data || [] });
  } catch (err) {
    console.error('admin-list-members', err);
    return send(res, 500, { error: 'server_error' });
  }
}
