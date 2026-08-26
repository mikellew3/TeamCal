import { serviceClient, readJson, send, methodGuard, resolveAdmin, nextAvailableColor, logAdminAction, ROLES, isAdminRole, sameId } from './_lib.js';

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

  const action = body?.action;
  if (!action) return send(res, 400, { error: 'missing_action' });

  try {
    const supa = serviceClient();
    const actor = await resolveAdmin(supa, body?.token);
    if (!actor) return send(res, 401, { error: 'unauthorized' });

    switch (action) {
      case 'create':         return await create(supa, body, res, actor);
      case 'approve':        return await approve(supa, body, res, actor);
      case 'deny':           return await deny(supa, body, res, actor);
      case 'deactivate':     return await setActive(supa, body, res, false, actor);
      case 'reactivate':     return await setActive(supa, body, res, true, actor);
      case 'update':         return await update(supa, body, res, actor);
      case 'reset_password': return await resetPassword(supa, body, res, actor);
      case 'delete':         return await hardDelete(supa, body, res, actor);
      default:               return send(res, 400, { error: 'unknown_action' });
    }
  } catch (err) {
    console.error('admin-member-action', action, err);
    return send(res, 500, { error: 'server_error' });
  }
}

async function create(supa, body, res, actor) {
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

  const fte = normalizeFte(body?.fte);
  const role = (actor.caps.manageRoles && ROLES.includes(body?.role)) ? body.role : 'member';
  const { data: row, error: tmErr } = await supa.from('team_members').insert({
    auth_user_id: created.user.id,
    name, email, color,
    active: true,
    signup_pending: false,
    must_change_password: true,
    fte,
    role,
  }).select('*').single();
  if (tmErr) {
    await supa.auth.admin.deleteUser(created.user.id).catch(() => {});
    throw tmErr;
  }
  logAdminAction(supa, { actor: actor.email, action: 'member_create', target_type: 'team_member', target_id: row.id, payload: { email: row.email, name: row.name, role: row.role } });
  return send(res, 200, { member: row });
}

async function approve(supa, body, res, actor) {
  const { id } = body || {};
  if (!id) return send(res, 400, { error: 'missing_id' });
  const { data, error } = await supa.from('team_members')
    .update({ active: true, signup_pending: false })
    .eq('id', id).select('*').single();
  if (error) throw error;
  logAdminAction(supa, { actor: actor.email, action: 'member_approve', target_type: 'team_member', target_id: id, payload: { email: data?.email } });
  return send(res, 200, { member: data });
}

async function deny(supa, body, res, actor) {
  const { id } = body || {};
  if (!id) return send(res, 400, { error: 'missing_id' });
  const { data: row } = await supa.from('team_members')
    .select('id, auth_user_id, signup_pending, role')
    .eq('id', id).maybeSingle();
  if (!row) return send(res, 404, { error: 'not_found' });
  // Deny is for rejecting an unapproved SIGNUP. It hard-deletes the row and
  // the auth user, so pointing it at an established member — or the last
  // Admin — is an unrecoverable delete wearing a friendlier name. The UI only
  // ever offers it on pending signups; enforce that server-side too.
  if (!row.signup_pending) {
    return send(res, 400, {
      error: 'not_a_pending_signup',
      detail: 'Deny only applies to pending signups. Use Deactivate for an existing member.',
    });
  }
  const blockedDeny = await lastAdminGuard(supa, id, { verb: 'deny' });
  if (blockedDeny) return send(res, 409, blockedDeny);
  const guarded = await adminTargetGuard(supa, id, actor, { verb: 'deny' });
  if (guarded) return send(res, 403, guarded);
  if (row.auth_user_id) {
    await supa.auth.admin.deleteUser(row.auth_user_id).catch(err => console.error('deny deleteUser', err));
  }
  const { error } = await supa.from('team_members').delete().eq('id', id);
  if (error) throw error;
  logAdminAction(supa, { actor: actor.email, action: 'member_deny', target_type: 'team_member', target_id: id, payload: { auth_user_id: row.auth_user_id } });
  return send(res, 200, { ok: true });
}

async function setActive(supa, body, res, value, actor) {
  const { id } = body || {};
  if (!id) return send(res, 400, { error: 'missing_id' });
  if (!value) {
    const blocked = await lastAdminGuard(supa, id, { verb: 'deactivate' });
    if (blocked) return send(res, 409, blocked);
    const guarded = await adminTargetGuard(supa, id, actor, { verb: 'deactivate' });
    if (guarded) return send(res, 403, guarded);
  }
  const { data, error } = await supa.from('team_members')
    .update({ active: value, signup_pending: false })
    .eq('id', id).select('*').single();
  if (error) throw error;
  logAdminAction(supa, { actor: actor.email, action: value ? 'member_reactivate' : 'member_deactivate', target_type: 'team_member', target_id: id, payload: { email: data?.email } });
  return send(res, 200, { member: data });
}

async function update(supa, body, res, actor) {
  const { id } = body || {};
  if (!id) return send(res, 400, { error: 'missing_id' });
  const patch = {};
  if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim();
  if (typeof body.email === 'string' && body.email.includes('@')) patch.email = body.email.trim().toLowerCase();
  if (typeof body.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.color)) patch.color = body.color;
  if ('fte' in body) patch.fte = normalizeFte(body.fte);

  // Role changes are full-admin only. Without this an Associate Admin could
  // promote themselves to 'admin' and the self-approval rule would evaporate
  // in one click — so this gate is load-bearing, not cosmetic.
  if ('role' in body) {
    if (!actor.caps.manageRoles) {
      return send(res, 403, {
        error: 'role_change_forbidden',
        detail: 'Only a full Admin can change roles.',
      });
    }
    if (!ROLES.includes(body.role)) return send(res, 400, { error: 'invalid_role' });
    if (sameId(id, actor.memberId)) {
      return send(res, 403, {
        error: 'self_role_change_forbidden',
        detail: 'You can’t change your own role. Ask another admin.',
      });
    }
    if (body.role !== 'admin') {
      const blocked = await lastAdminGuard(supa, id, { verb: 'demote' });
      if (blocked) return send(res, 409, blocked);
    }
    patch.role = body.role;
  }

  if (Object.keys(patch).length === 0) return send(res, 400, { error: 'nothing_to_update' });

  if (patch.email || patch.name) {
    const guarded = await adminTargetGuard(supa, id, actor, { verb: 'edit' });
    if (guarded) return send(res, 403, guarded);
  }

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
  logAdminAction(supa, { actor: actor.email, action: 'member_update', target_type: 'team_member', target_id: id, payload: { fields: Object.keys(patch), role: patch.role ?? undefined } });
  return send(res, 200, { member: data });
}

async function resetPassword(supa, body, res, actor) {
  const { id, password } = body || {};
  if (!id) return send(res, 400, { error: 'missing_id' });
  if (!password || password.length < 8) return send(res, 400, { error: 'invalid_password' });
  const guarded = await adminTargetGuard(supa, id, actor, { verb: 'reset the password on' });
  if (guarded) return send(res, 403, guarded);
  const { data: row } = await supa.from('team_members').select('auth_user_id').eq('id', id).maybeSingle();
  if (!row?.auth_user_id) return send(res, 404, { error: 'no_auth_user' });
  const { error } = await supa.auth.admin.updateUserById(row.auth_user_id, { password });
  if (error) throw error;
  // Force the member to pick their own password on next sign-in.
  await supa.from('team_members').update({ must_change_password: true }).eq('id', id);
  logAdminAction(supa, { actor: actor.email, action: 'member_reset_password', target_type: 'team_member', target_id: id });
  return send(res, 200, { ok: true });
}

async function hardDelete(supa, body, res, actor) {
  const { id } = body || {};
  if (!id) return send(res, 400, { error: 'missing_id' });
  const blocked = await lastAdminGuard(supa, id, { verb: 'delete' });
  if (blocked) return send(res, 409, blocked);
  const guarded = await adminTargetGuard(supa, id, actor, { verb: 'delete' });
  if (guarded) return send(res, 403, guarded);
  const { data: row } = await supa.from('team_members').select('auth_user_id').eq('id', id).maybeSingle();
  if (!row) return send(res, 404, { error: 'not_found' });
  if (row.auth_user_id) {
    await supa.auth.admin.deleteUser(row.auth_user_id).catch(err => console.error('hardDelete auth', err));
  }
  const { error } = await supa.from('team_members').delete().eq('id', id);
  if (error) throw error;
  logAdminAction(supa, { actor: actor.email, action: 'member_delete', target_type: 'team_member', target_id: id, payload: { auth_user_id: row.auth_user_id } });
  return send(res, 200, { ok: true });
}

// An Associate Admin must not perform account actions against an admin-role
// account. Resetting a full Admin's password (or changing their email) hands
// over that account, which is a complete bypass of every role rule below it.
// Full Admins may act on anyone.
async function adminTargetGuard(supa, id, actor, { verb }) {
  if (actor.caps.manageRoles) return null;          // full Admin: allowed
  const { data: target } = await supa
    .from('team_members').select('id, role').eq('id', id).maybeSingle();
  if (!target || !isAdminRole(target.role)) return null;
  if (sameId(target.id, actor.memberId)) return null;  // acting on yourself is fine
  return {
    error: 'admin_target_forbidden',
    detail: `Only a full Admin can ${verb} another admin's account.`,
  };
}

// Refuse to remove the last full Admin — demoting, deactivating, or deleting
// them would leave nobody who can approve their own time away, change roles,
// or restore access. Returns an error body to send, or null if it's safe.
async function lastAdminGuard(supa, id, { verb }) {
  const { data: target } = await supa
    .from('team_members').select('id, role, active').eq('id', id).maybeSingle();
  if (!target || target.role !== 'admin') return null;
  const { count } = await supa
    .from('team_members')
    .select('id', { count: 'exact', head: true })
    .eq('role', 'admin')
    .eq('active', true);
  if ((count ?? 0) > 1) return null;
  return {
    error: 'last_admin',
    detail: `This is the only active Admin — promote someone else before you ${verb} them.`,
  };
}

// FTE: 1.0 full-time, 0.5 half-time, 0 per diem. Anything else falls back to 1.0.
function normalizeFte(v) {
  const n = Number(v);
  if (n === 1 || n === 0.5 || n === 0) return n;
  return 1.0;
}
