/**
 * Gates the entire site (static page + /api) behind HTTP Basic Auth.
 * Credentials are set via `wrangler pages secret put BASIC_AUTH_USER` /
 * `BASIC_AUTH_PASS` (or .dev.vars locally) - never hardcoded here, since
 * this file is committed to a public repo.
 */
export async function onRequest(context) {
  const { request, env, next } = context;

  const expectedUser = env.BASIC_AUTH_USER;
  const expectedPass = env.BASIC_AUTH_PASS;

  // fail closed: if auth isn't configured, deny everyone rather than let it through
  if (!expectedUser || !expectedPass) {
    return new Response('Auth not configured', { status: 500 });
  }

  const auth = request.headers.get('Authorization') || '';
  const [scheme, encoded] = auth.split(' ');

  if (scheme === 'Basic' && encoded) {
    let decoded = '';
    try { decoded = atob(encoded); } catch (e) { /* fall through to 401 */ }
    const sep = decoded.indexOf(':');
    const user = sep >= 0 ? decoded.slice(0, sep) : '';
    const pass = sep >= 0 ? decoded.slice(sep + 1) : '';
    if (user === expectedUser && pass === expectedPass) {
      return next();
    }
  }

  return new Response('Authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Iceano Inventory", charset="UTF-8"' }
  });
}
