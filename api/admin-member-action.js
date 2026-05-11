import { serviceClient, readJson, send, methodGuard, verifyAdminToken, nextAvailableColor, logAdminAction } from './_lib.js';

// POST { token, action, ...args } — single endpoint for all member-mgmt:
//   action: 'create'      args: { name, email, color, password }
//   action: 'approve'     args: { id }
//   action: 'deny'        args: { id }
//   action: 'deactivate'  args: { id }
//   action: 'reactivate'  args: { id }
//   action: 'update'      args: { id, name?, email?, color? }
//   action: 'reset_password'  args: { id, password }
//   action: 'delete'      args: { id }   // hard delete (use with care)
export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;
  const body = await readJson(req);
  if (!verifyAdminToken(body?.token)) return send(res, 401, { error: 'unauthorized' });

  const action = body?.action;
  if (!action) return send(res, 400, { error: 'missing_action' });

  try {
    const supa = serviceClient();
    switch (action) {
      case 'create':         return await create(supa, body, res);
      case 'approve':        return await approve(supa, body, res);
      case 'deny':           return await deny(supa, body, res);
      case 'deactivate':     return await setActive(supa, body, res, false);
      case 'reactivate':     return await setActive(supa, body, res, true);
      case 'update':         return await update(supa, body, res);
      case 'reset_password': return await resetPassword(supa, body, res);
      case 'delete':         return await hardDelete(supa, body, res);
      default:               return send(res, 400, { error: 'unknown_action' });
    }
  } catch (err) {
    console.error('admin-member-action', action, err);
    return send(res, 500, { error: 'server_error' });
  }
}

async function create(supa, body, res) {
  const name = (body?.name || '').trim();
  const email = (body?.email || '').trim().toLowerCase();
  const color = body?.color || await nextAvailableColor(supa, name);
  const password = body?.password || '';
  if (!name || name.length < 2) return send(res, 400, { error: 'invalid_name' });
  if (!email.includes('@')) return send(res, 400, { error: 'invalid_email' });
  if (!password || password.length < 8) return send(res, 400, { error: 'invalid_password' });

  const { data: existing } = await supa.from('team_members').select('id').ilike('email', email).maybeSingle();
  if (existing) return send(res, 409, { error: 'already_exists' });

  const { data: created, error: createErr } = await supa.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { full_name: name },
  });
  if (createErr) {
    const m = (createErr.message || '').toLowerCase();
    if (m.includes('already')) return send(res, 409, { error: 'already_exists' });
    throw createErr;
  }

  const { data: row, error: tmErr } = await supa.from('team_members').insert({
    auth_user_id: created.user.id,
    name, email, color,
    active: true,
    signup_pending: false,
  }).select('*').single();
  if (tmErr) {
    await supa.auth.admin.deleteUser(created.user.id).catch(() => {});
    throw tmErr;
  }
  logAdminAction(supa, { actor: null, action: 'member_create', target_type: 'team_member', target_id: row.id, payload: { email: row.email, name: row.name } });
  return send(res, 200, { member: row });
}

async function approve(supa, body, res) {
  const { id } = body || {};
  if (!id) return send(res, 400, { error: 'missing_id' });
  const { data, error } = await supa.from('team_members')
    .update({ active: true, signup_pending: false })
    .eq('id', id).select('*').single();
  if (error) throw error;
  logAdminAction(supa, { actor: null, action: 'member_approve', target_type: 'team_member', target_id: id, payload: { email: data?.email } });
  return send(res, 200, { member: data });
}

async function deny(supa, body, res) {
  const { id } = body || {};
  if (!id) return send(res, 400, { error: 'missing_id' });
  const { data: row } = await supa.from('team_members')
    .select('id, auth_user_id, signup_pending')
    .eq('id', id).maybeSingle();
  if (!row) return send(res, 404, { error: 'not_found' });
  if (row.auth_user_id) {
    await supa.auth.admin.deleteUser(row.auth_user_id).catch(err => console.error('deny deleteUser', err));
  }
  const { error } = await supa.from('team_members').delete().eq('id', id);
  if (error) throw error;
  logAdminAction(supa, { actor: null, action: 'member_deny', target_type: 'team_member', target_id: id, payload: { auth_user_id: row.auth_user_id } });
  return send(res, 200, { ok: true });
}

async function setActive(supa, body, res, value) {
  const { id } = body || {};
  if (!id) return send(res, 400, { error: 'missing_id' });
  const { data, error } = await supa.from('team_members')
    .update({ active: value, signup_pending: false })
    .eq('id', id).select('*').single();
  if (error) throw error;
  logAdminAction(supa, { actor: null, action: value ? 'member_reactivate' : 'member_deactivate', target_type: 'team_member', target_id: id, payload: { email: data?.email } });
  return send(res, 200, { member: data });
}

async function update(supa, body, res) {
  const { id } = body || {};
  if (!id) return send(res, 400, { error: 'missing_id' });
  const patch = {};
  if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim();
  if (typeof body.email === 'string' && body.email.includes('@')) patch.email = body.email.trim().toLowerCase();
  if (typeof body.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.color)) patch.color = body.color;
  if (Object.keys(patch).length === 0) return send(res, 400, { error: 'nothing_to_update' });

  // If email is changing, also update the auth user.
  if (patch.email) {
    const { data: row } = await supa.from('team_members').select('auth_user_id, email').eq('id', id).maybeSingle();
    if (row?.auth_user_id && row.email.toLowerCase() !== patch.email) {
      await supa.auth.admin.updateUserById(row.auth_user_id, { email: patch.email, email_confirm: true })
        .catch(err => console.error('update auth email', err));
    }
  }

  const { data, error } = await supa.from('team_members').update(patch).eq('id', id).select('*').single();
  if (error) throw error;
  logAdminAction(supa, { actor: null, action: 'member_update', target_type: 'team_member', target_id: id, payload: { fields: Object.keys(patch) } });
  return send(res, 200, { member: data });
}

async function resetPassword(supa, body, res) {
  const { id, password } = body || {};
  if (!id) return send(res, 400, { error: 'missing_id' });
  if (!password || password.length < 8) return send(res, 400, { error: 'invalid_password' });
  const { data: row } = await supa.from('team_members').select('auth_user_id').eq('id', id).maybeSingle();
  if (!row?.auth_user_id) return send(res, 404, { error: 'no_auth_user' });
  const { error } = await supa.auth.admin.updateUserById(row.auth_user_id, { password });
  if (error) throw error;
  logAdminAction(supa, { actor: null, action: 'member_reset_password', target_type: 'team_member', target_id: id });
  return send(res, 200, { ok: true });
}

async function hardDelete(supa, body, res) {
  const { id } = body || {};
  if (!id) return send(res, 400, { error: 'missing_id' });
  const { data: row } = await supa.from('team_members').select('auth_user_id').eq('id', id).maybeSingle();
  if (!row) return send(res, 404, { error: 'not_found' });
  if (row.auth_user_id) {
    await supa.auth.admin.deleteUser(row.auth_user_id).catch(err => console.error('hardDelete auth', err));
  }
  const { error } = await supa.from('team_members').delete().eq('id', id);
  if (error) throw error;
  logAdminAction(supa, { actor: null, action: 'member_delete', target_type: 'team_member', target_id: id, payload: { auth_user_id: row.auth_user_id } });
  return send(res, 200, { ok: true });
}
