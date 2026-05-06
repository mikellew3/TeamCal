// Serves the public config to the browser. SUPABASE_URL + ANON_KEY are safe
// to expose (RLS protects writes; reads are intentionally open to
// authenticated users). VAPID_PUBLIC_KEY is also a public key.
export default function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.statusCode = 405;
    res.end();
    return;
  }
  const body = {
    SUPABASE_URL: process.env.SUPABASE_URL || '',
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || '',
    VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY || '',
    APP_URL: process.env.APP_URL || '',
  };
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.end(JSON.stringify(body));
}
