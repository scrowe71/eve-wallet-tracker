// Signed-cookie browser sessions (replacement for Starlette's SessionMiddleware).
//
// The cookie holds base64url(JSON) plus an HMAC-SHA256 signature made with the
// SECRET_KEY secret, so it can be read but not forged or edited by the browser.

const COOKIE = 'evewallet_session';
const MAX_AGE = 14 * 24 * 3600; // two weeks, same as before

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(text) {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

const keyCache = new Map();
async function hmacKey(secret) {
  let key = keyCache.get(secret);
  if (!key) {
    key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    keyCache.set(secret, key);
  }
  return key;
}

function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export class Session {
  constructor(data, secret) {
    this.data = data || {};
    this.secret = secret;
    this.dirty = false;
    this.path = '/'; // current request path, for the active tab (not stored)
  }

  static async load(request, secret) {
    if (!secret) throw new Error('SECRET_KEY is not set. Add it as a secret in the Worker settings.');
    const value = readCookie(request, COOKIE);
    if (value) {
      const [payload, sig] = value.split('.');
      if (payload && sig) {
        try {
          const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), unb64url(sig), enc.encode(payload));
          if (ok) {
            const data = JSON.parse(dec.decode(unb64url(payload)));
            if (data && typeof data === 'object' && (!data._exp || data._exp > Date.now() / 1000)) {
              delete data._exp;
              return new Session(data, secret);
            }
          }
        } catch {
          // Unreadable cookie: start a fresh session.
        }
      }
    }
    return new Session({}, secret);
  }

  get(key, fallback = undefined) {
    return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : fallback;
  }

  set(key, value) {
    this.data[key] = value;
    this.dirty = true;
  }

  pop(key, fallback = undefined) {
    if (!Object.prototype.hasOwnProperty.call(this.data, key)) return fallback;
    const value = this.data[key];
    delete this.data[key];
    this.dirty = true;
    return value;
  }

  clear() {
    this.data = {};
    this.dirty = true;
  }

  /** Logged-in local user id, or null. */
  userId() {
    const value = this.data.user_id;
    if (value === undefined || value === null) return null;
    const n = parseInt(value, 10);
    if (Number.isNaN(n)) {
      this.clear();
      return null;
    }
    return n;
  }

  timezone() {
    return this.data.timezone || 'UTC';
  }

  /** Add Set-Cookie to the response when the session changed. */
  async commit(response) {
    const empty = Object.keys(this.data).length === 0;
    // Like Starlette: re-send a non-empty session on every response so the two-week expiry slides.
    if (empty && !this.dirty) return response;
    const out = new Response(response.body, response);
    if (empty) {
      out.headers.append('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
      return out;
    }
    const payload = b64url(enc.encode(JSON.stringify({ ...this.data, _exp: Math.floor(Date.now() / 1000) + MAX_AGE })));
    const sig = b64url(new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(this.secret), enc.encode(payload))));
    out.headers.append('Set-Cookie', `${COOKIE}=${payload}.${sig}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax`);
    return out;
  }
}
