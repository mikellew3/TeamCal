// Push helper. Loaded lazily so endpoints that don't push don't pay the
// cold-start cost of the web-push module.
import webpush from 'web-push';
import { serviceClient } from './_lib.js';

let configured = false;
function configure() {
  if (configured) return true;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@example.com';
  if (!pub || !priv) return false;
  webpush.setVapidDetails(`mailto:${adminEmail}`, pub, priv);
  configured = true;
  return true;
}

// Send a push to either { recipientType: 'admin' } (all admin subscriptions)
// or { recipientType: 'member', memberId } (all that member's devices).
//
// payload is an object with at minimum { title, body }. Optional:
//   { entryId, url, tag }
//
// Returns silently on configuration / DB issues so the caller never crashes.
export async function sendPush({ recipientType, memberId, payload }) {
  if (!configure()) {
    console.warn('[push] skipped: VAPID not configured');
    return { sent: 0, reason: 'vapid_not_configured' };
  }
  let supa;
  try { supa = serviceClient(); } catch {
    console.warn('[push] skipped: no supabase client');
    return { sent: 0, reason: 'no_supabase' };
  }

  let q = supa.from('push_subscriptions').select('*');
  if (recipientType === 'admin') q = q.eq('is_admin', true);
  else if (recipientType === 'member' && memberId) q = q.eq('member_id', memberId);
  else {
    console.warn('[push] skipped: no recipient', { recipientType, memberId });
    return { sent: 0, reason: 'no_recipient' };
  }

  const { data: subs, error } = await q;
  if (error) {
    console.error('[push] sub lookup failed', error);
    return { sent: 0, reason: 'db_error' };
  }
  if (!subs?.length) {
    console.warn('[push] no matching subscriptions', { recipientType, memberId });
    return { sent: 0, reason: 'no_subscriptions' };
  }
  console.log(`[push] dispatching to ${subs.length} subscription(s)`, { recipientType, memberId });

  const body = JSON.stringify(payload || {});
  const results = await Promise.allSettled(
    subs.map(sub => webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      body
    ))
  );

  const expired = [];
  let sent = 0;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') sent++;
    else {
      const code = r.reason?.statusCode;
      if (code === 404 || code === 410) expired.push(subs[i].endpoint);
      else console.error('push send error', code, r.reason?.body || r.reason?.message);
    }
  });
  if (expired.length) {
    await supa.from('push_subscriptions').delete().in('endpoint', expired);
    console.warn(`[push] removed ${expired.length} expired subscription(s)`);
  }
  console.log(`[push] result`, { sent, expired: expired.length, total: subs.length });
  // Best-effort touch last_used_at for non-expired subs.
  const aliveEndpoints = subs.filter(s => !expired.includes(s.endpoint)).map(s => s.endpoint);
  if (aliveEndpoints.length) {
    supa.from('push_subscriptions')
      .update({ last_used_at: new Date().toISOString() })
      .in('endpoint', aliveEndpoints)
      .then(() => {}, () => {});
  }
  return { sent, expired: expired.length };
}
