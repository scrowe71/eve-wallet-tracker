// EVE SSO login, add-character, logout and callback (was routers/auth.py).

import { first, run } from '../db.js';
import { buildAuthorizeUrl, exchangeCodeForToken, characterInfoFromToken, tokenExpiresAt } from '../esi.js';
import { redirect, httpError } from '../http.js';
import { nowDb } from '../time.js';

function randomState() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function beginSso(env, session, mode) {
  const state = randomState();
  session.set('eve_sso_state', state);
  session.set('eve_sso_mode', mode);
  return redirect(buildAuthorizeUrl(env, state), 307);
}

export function login(req) {
  return beginSso(req.env, req.session, 'login');
}

export function addCharacter(req) {
  if (!req.session.get('user_id')) return redirect('/auth/login');
  return beginSso(req.env, req.session, 'add_character');
}

export function logout(req) {
  req.session.clear();
  return redirect('/');
}

export async function callback(req) {
  const { env, session, url } = req;
  const db = env.DB;
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const expected = session.get('eve_sso_state');
  if (!expected || state !== expected) return httpError(400, 'Invalid EVE SSO state');
  if (!code) return httpError(400, 'Missing EVE SSO code');

  const tokens = await exchangeCodeForToken(env, code);
  const info = characterInfoFromToken(tokens.access_token);
  const characterId = info.character_id;
  const characterName = info.character_name;
  const ownerHash = info.owner_hash;
  const now = nowDb();

  const mode = session.get('eve_sso_mode') || 'login';
  const currentUserId = session.get('user_id');
  const character = await first(db, 'SELECT * FROM characters WHERE character_id = ?', characterId);

  let user;
  if (mode === 'add_character') {
    if (!currentUserId) {
      session.clear();
      return httpError(400, 'Login required before adding a character.');
    }
    user = await first(db, 'SELECT * FROM users WHERE id = ?', parseInt(currentUserId, 10));
    if (!user) {
      session.clear();
      return httpError(400, 'Login session expired. Log in again.');
    }
    if (character && Number(character.user_id) !== Number(user.id)) {
      return httpError(400, 'That EVE character is already linked to another local user.');
    }
  } else {
    if (character) {
      user = await first(db, 'SELECT * FROM users WHERE id = ?', character.user_id);
    } else {
      user = await first(db, 'SELECT * FROM users WHERE eve_character_id = ?', characterId);
      if (!user) {
        user = await first(db,
          `INSERT INTO users (eve_character_id, eve_character_name, owner_hash, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?) RETURNING *`,
          characterId, characterName, ownerHash, now, now);
      }
    }
    session.set('user_id', user.id);
    session.set('user_character_name', user.eve_character_name);
    session.set('user_character_id', user.eve_character_id);
  }

  const expires = tokenExpiresAt(tokens);
  if (character) {
    await run(db,
      `UPDATE characters SET user_id = ?, character_name = ?, owner_hash = ?, access_token = ?, refresh_token = ?,
       token_expires_at = ?, updated_at = ? WHERE id = ?`,
      user.id, characterName, ownerHash, tokens.access_token ?? null, tokens.refresh_token ?? null, expires, now, character.id);
  } else {
    await run(db,
      `INSERT INTO characters (user_id, character_id, character_name, owner_hash, access_token, refresh_token,
       token_expires_at, last_wallet_sync_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      user.id, characterId, characterName, ownerHash, tokens.access_token ?? null, tokens.refresh_token ?? null, expires, now, now);
  }

  // Keep the user's displayed name fresh if this login is their primary character.
  if (Number(user.eve_character_id) === Number(characterId)) {
    await run(db, 'UPDATE users SET eve_character_name = ?, owner_hash = ?, updated_at = ? WHERE id = ?', characterName, ownerHash, now, user.id);
    session.set('user_character_name', characterName);
  }

  session.pop('eve_sso_state');
  session.pop('eve_sso_mode');
  return redirect('/characters?linked=1');
}
