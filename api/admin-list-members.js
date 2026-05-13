import { serviceClient, readJson, send, methodGuard, verifyAdminToken } from './_lib.js';

// POST { token } → { members: [...] } including pending and inactive
// POST { token, kind: 'actions', limit? } → { actions: [...] } newest first,
//   from the admin_actions audit table. Default limit 100, max 500.
export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;
  const body = await readJson(req);
  if (!verifyAdminToken(body?.token)) return send(res, 401, { error: 'unauthorized' });

  try {
    const supa = serviceClient();

    if (body?.kind === 'actions') {
      const requested = parseInt(body?.limit ?? 100, 10) || 100;
      const limit = Math.min(Math.max(requested, 1), 500);
      const { data, error } = await supa
        .from('admin_actions')
        .select('id, actor_email, action, target_type, target_id, payload, created_at')
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return send(res, 200, { actions: data || [] });
    }

    const { data, error } = await supa
      .from('team_members')
      .select('id, name, email, color, active, signup_pending, must_change_password, auth_user_id, created_at')
      .order('signup_pending', { ascending: false })
      .order('active', { ascending: false })
      .order('name', { ascending: true });
    if (error) throw error;
    return send(res, 200, { members: data || [] });
  } catch (err) {
    console.error('admin-list-members', err);
    return send(res, 500, { error: 'server_error', detail: String(err?.message || err) });
  }
}
