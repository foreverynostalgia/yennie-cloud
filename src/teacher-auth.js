// Teacher sign-in with Google (OpenID Connect, authorization code + PKCE),
// replacing the ChatGPT Sites identity headers. Sessions are HMAC-signed,
// HttpOnly cookies. Students never use this: the student portal keeps its own
// nickname + PIN sessions.
//
// Runtime config: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (secret),
// TEACHER_SESSION_SECRET (secret, >= 32 chars).
const TEACHER_COOKIE = 'ys_teacher', OAUTH_COOKIE = 'ys_oauth';
const TEACHER_SESSION_SECONDS = 7 * 24 * 3600, OAUTH_SECONDS = 600;
const authEnc = new TextEncoder();
const authB64 = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const authUnb64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const authRandom = (n = 32) => authB64(crypto.getRandomValues(new Uint8Array(n)));

function authSecret(env) {
  const s = String(env.TEACHER_SESSION_SECRET || '');
  if (s.length < 32) throw {status: 503, message: '로그인 설정이 필요합니다.'};
  return s;
}
async function authMac(env, purpose, data) {
  const key = await crypto.subtle.importKey('raw', authEnc.encode(authSecret(env)), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  return authB64(new Uint8Array(await crypto.subtle.sign('HMAC', key, authEnc.encode(purpose + '.' + data))));
}
async function authSign(env, purpose, value) {
  const data = authB64(authEnc.encode(JSON.stringify(value)));
  return data + '.' + await authMac(env, purpose, data);
}
async function authVerify(env, purpose, token) {
  const [data, mac, ...extra] = String(token || '').split('.');
  if (!data || !mac || extra.length) return null;
  const expected = await authMac(env, purpose, data);
  if (expected.length !== mac.length) return null;
  let diff = 0;
  for (let i = 0; i < mac.length; i++) diff |= mac.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff) return null;
  try {
    const value = JSON.parse(new TextDecoder().decode(authUnb64(data)));
    return value && typeof value.exp === 'number' && value.exp > Date.now() / 1000 ? value : null;
  } catch { return null; }
}
function authCookie(r, name) {
  return (r.headers.get('cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(name + '='))?.slice(name.length + 1) || '';
}
const authSetCookie = (name, value, maxAge, path = '/') => `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
function authReturnTo(value) {
  const v = String(value || '/');
  return v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/\\') && v.length < 300 ? v : '/';
}
function authRedirect(location, cookies = []) {
  const h = new Headers({Location: location, 'Cache-Control': 'no-store'});
  for (const c of cookies) h.append('Set-Cookie', c);
  return new Response(null, {status: 302, headers: h});
}

// Returns {id, email} for a signed-in teacher, or null.
async function teacherIdentity(r, env) {
  const value = await authVerify(env, 'teacher-session-v1', authCookie(r, TEACHER_COOKIE));
  return value && typeof value.id === 'string' && typeof value.email === 'string' ? {id: value.id, email: value.email} : null;
}

// Handles /auth/* (and the old ChatGPT sign-in paths); returns null otherwise.
async function handleTeacherAuth(r, env) {
  const url = new URL(r.url), p = url.pathname;
  if (!['/auth/google', '/auth/google/callback', '/auth/signout', '/signin-with-chatgpt', '/signout-with-chatgpt'].includes(p)) return null;
  if (r.method !== 'GET') return Response.json({error: 'Method Not Allowed'}, {status: 405});
  const returnTo = authReturnTo(url.searchParams.get('return_to'));
  if (p === '/auth/signout' || p === '/signout-with-chatgpt') return authRedirect(returnTo, [authSetCookie(TEACHER_COOKIE, '', 0)]);
  if (p === '/signin-with-chatgpt') return authRedirect('/auth/google?return_to=' + encodeURIComponent(returnTo));
  const clientId = String(env.GOOGLE_CLIENT_ID || ''), clientSecret = String(env.GOOGLE_CLIENT_SECRET || '');
  if (!clientId || !clientSecret) throw {status: 503, message: '구글 로그인 설정이 필요합니다.'};
  const redirectUri = url.origin + '/auth/google/callback';
  if (p === '/auth/google') {
    const state = authRandom(), nonce = authRandom(), verifier = authRandom(48);
    const challenge = authB64(new Uint8Array(await crypto.subtle.digest('SHA-256', authEnc.encode(verifier))));
    const pending = await authSign(env, 'teacher-oauth-v1', {state, nonce, verifier, returnTo, exp: Math.floor(Date.now() / 1000) + OAUTH_SECONDS});
    const google = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    for (const [k, v] of Object.entries({client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid email profile', state, nonce, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account'})) google.searchParams.set(k, v);
    return authRedirect(google.toString(), [authSetCookie(OAUTH_COOKIE, pending, OAUTH_SECONDS, '/auth/google')]);
  }
  // Callback
  const fail = message => authRedirect('/?login_error=' + encodeURIComponent(message), [authSetCookie(OAUTH_COOKIE, '', 0, '/auth/google')]);
  const pending = await authVerify(env, 'teacher-oauth-v1', authCookie(r, OAUTH_COOKIE));
  const state = url.searchParams.get('state') || '', code = url.searchParams.get('code') || '';
  if (!pending || !state || state !== pending.state) return fail('로그인 요청이 만료되었습니다. 다시 시도해 주세요.');
  if (!code) return fail('구글 로그인이 취소되었습니다.');
  const res = await fetch('https://oauth2.googleapis.com/token', {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: pending.verifier})});
  if (!res.ok) return fail('구글 로그인을 확인하지 못했습니다.');
  let claims;
  try {
    const {id_token} = await res.json();
    const parts = String(id_token || '').split('.');
    if (parts.length !== 3) throw 0;
    claims = JSON.parse(new TextDecoder().decode(authUnb64(parts[1])));
  } catch { return fail('구글 로그인을 확인하지 못했습니다.'); }
  // The ID token came straight from Google's token endpoint over TLS
  // (OIDC Core 3.1.3.7), so we validate its claims rather than its signature.
  const now = Math.floor(Date.now() / 1000);
  if (!['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss) || claims.aud !== clientId || typeof claims.exp !== 'number' || claims.exp <= now
    || claims.nonce !== pending.nonce || typeof claims.sub !== 'string' || !claims.sub || claims.email_verified !== true || typeof claims.email !== 'string' || !claims.email.includes('@'))
    return fail('확인된 구글 이메일로 로그인해 주세요.');
  const session = await authSign(env, 'teacher-session-v1', {id: 'google:' + claims.sub, email: claims.email.toLowerCase(), exp: now + TEACHER_SESSION_SECONDS});
  return authRedirect(authReturnTo(pending.returnTo), [authSetCookie(TEACHER_COOKIE, session, TEACHER_SESSION_SECONDS), authSetCookie(OAUTH_COOKIE, '', 0, '/auth/google')]);
}
