// EVE SSO and ESI wallet journal sync.

import { settings, USER_AGENT, ESI_BASE, ESI_COMPAT_DATE } from './config.js';
import { first, run } from './db.js';
import { parseDb, toDb, nowDb } from './time.js';

const AUTHORIZE_URL = 'https://login.eveonline.com/v2/oauth/authorize/';
const TOKEN_URL = 'https://login.eveonline.com/v2/oauth/token';
const SCOPES = ['esi-wallet.read_character_wallet.v1'];

// ---------- SSO ----------

export function buildAuthorizeUrl(env, state) {
  const cfg = settings(env);
  const params = new URLSearchParams({
    response_type: 'code',
    redirect_uri: cfg.EVE_CALLBACK_URL,
    client_id: cfg.EVE_CLIENT_ID,
    scope: SCOPES.join(' '),
    state,
  });
  return `${AUTHORIZE_URL}?${params}`;
}

async function tokenRequest(env, form) {
  const cfg = settings(env);
  if (!cfg.EVE_CLIENT_ID || !cfg.EVE_CLIENT_SECRET) throw new Error('EVE_CLIENT_ID / EVE_CLIENT_SECRET are not configured.');
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${cfg.EVE_CLIENT_ID}:${cfg.EVE_CLIENT_SECRET}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
    },
    body: new URLSearchParams(form),
  });
  if (!r.ok) throw new Error(`EVE SSO returned HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

export const exchangeCodeForToken = (env, code) => tokenRequest(env, { grant_type: 'authorization_code', code });
export const refreshAccessToken = (env, refreshToken) => tokenRequest(env, { grant_type: 'refresh_token', refresh_token: refreshToken });

export function characterInfoFromToken(accessToken) {
  const parts = String(accessToken).split('.');
  if (parts.length < 2) throw new Error('Access token is not a JWT');
  const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const json = new TextDecoder().decode(Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0)));
  const payload = JSON.parse(json);
  const sub = String(payload.sub || '');
  const characterId = parseInt(sub.includes(':') ? sub.split(':').pop() : sub, 10);
  return {
    character_id: characterId,
    character_name: payload.name || payload.preferred_username || `Character ${characterId}`,
    owner_hash: payload.owner || null,
  };
}

export const tokenExpiresAt = (tokens) => toDb(Date.now() + Number(tokens.expires_in || 1200) * 1000);

// ---------- Wallet classification ----------

// Only true activity income belongs in reports/sessions. Day-to-day transfers,
// donations, withdrawals, fees, taxes, purchases, and other spending remain visible
// in Raw Data but are excluded from dashboard/session/ISK-hour calculations.
const EXCLUDED_REF_TYPES = new Set([
  'player_donation',
  'corporation_account_withdrawal',
  'daily_goal_payouts',
  'market_escrow',
  'contract_brokers_fee',
  'asset_safety_recovery_tax',
  'jump_clone_activation_fee',
  'jump_clone_installation_fee',
  'repair_bill',
  'skill_purchase',
  'structure_gate_jump',
  // Tax rows are excluded because observed ESI imports are already net of tax.
  'corporate_reward_tax',
  'corporation_tax',
]);

const REF_ACTIVITY_MAP = {
  bounty_prizes: 'Ratting',
  ess_escrow_transfer: 'Ratting',
  freelance_jobs_reward: 'Ratting',
  freelance_jobs_reward_corporation_tax: 'Ratting',
  agent_mission_reward: 'Missions',
  agent_mission_time_bonus_reward: 'Missions',
  mission_reward: 'Missions',
  mission_time_bonus_reward: 'Missions',
  incursion_payout: 'Incursions',
  corporate_reward_payout: 'Incursions',
};

export function classifyWalletEntry(refType, description) {
  const lower = String(refType || '').toLowerCase();
  const desc = String(description || '').toLowerCase();
  if (EXCLUDED_REF_TYPES.has(lower)) return null;
  if (desc.includes('deposited cash') || desc.includes('player donation')) return null;
  if (desc.includes('tax on concord rewards') || desc.includes('tax on pirate bounties')) return null;
  // Incursion payouts appear as "CONCORD rewarded X for services performed."
  if (desc.includes('concord rewarded') && desc.includes('for services performed')) return 'Incursions';
  if (Object.prototype.hasOwnProperty.call(REF_ACTIVITY_MAP, lower)) return REF_ACTIVITY_MAP[lower];
  if (lower.includes('bounty') || lower.includes('ess')) return 'Ratting';
  if (lower.includes('mission')) return 'Missions';
  if (lower.includes('incursion') || lower.includes('concord')) return 'Incursions';
  return null;
}

// ---------- Wallet sync ----------

export async function ensureValidAccessToken(env, character) {
  const expires = parseDb(character.token_expires_at);
  if (character.access_token && expires && expires > Date.now() + 2 * 60 * 1000) return character.access_token;
  if (!character.refresh_token) throw new Error(`${character.character_name} has no refresh token`);
  const tokens = await refreshAccessToken(env, character.refresh_token);
  character.access_token = tokens.access_token;
  if (tokens.refresh_token) character.refresh_token = tokens.refresh_token;
  character.token_expires_at = tokenExpiresAt(tokens);
  await run(env.DB,
    'UPDATE characters SET access_token = ?, refresh_token = ?, token_expires_at = ?, updated_at = ? WHERE id = ?',
    character.access_token, character.refresh_token, character.token_expires_at, nowDb(), character.id);
  return character.access_token;
}

const INSERT_WALLET_JSON = `
INSERT OR IGNORE INTO wallet_entries
  (esi_journal_id, character_id, entry_date, ref_type, description, amount, balance, activity_type, session_id, created_at)
SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.d'), json_extract(value, '$.r'),
       json_extract(value, '$.x'), json_extract(value, '$.a'), json_extract(value, '$.b'),
       json_extract(value, '$.t'), NULL, ?
FROM json_each(?)`;

export async function syncCharacterWallet(env, character) {
  const cfg = settings(env);
  const now = Date.now();
  const last = parseDb(character.last_wallet_sync_at);
  if (last && now - last < cfg.ESI_SYNC_COOLDOWN_MINUTES * 60 * 1000) {
    return { character: character.character_name, status: 'skipped', inserted: 0, reason: 'cooldown' };
  }

  const accessToken = await ensureValidAccessToken(env, character);
  const rows = [];
  let page = 1;
  let pages = 1;
  do {
    const url = `${ESI_BASE}/characters/${character.character_id}/wallet/journal/?page=${page}`;
    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': USER_AGENT,
        'X-Compatibility-Date': ESI_COMPAT_DATE,
        Accept: 'application/json',
      },
    });
    if (r.status === 404) break;
    if (!r.ok) throw new Error(`ESI wallet journal returned HTTP ${r.status}`);
    pages = parseInt(r.headers.get('X-Pages') || '1', 10) || 1;
    const items = await r.json();
    if (!items || !items.length) break;
    for (const item of items) {
      const amount = Number(item.amount || 0);
      if (amount <= 0) continue;
      rows.push({
        id: Number(item.id),
        d: toDb(Date.parse(item.date)),
        r: item.ref_type || '',
        x: item.description ?? null,
        a: amount,
        b: item.balance === undefined || item.balance === null ? null : Number(item.balance),
        t: classifyWalletEntry(item.ref_type || '', item.description),
      });
    }
    page += 1;
  } while (page <= pages);

  let inserted = 0;
  const createdAt = nowDb();
  const stmts = [];
  for (let i = 0; i < rows.length; i += 300) {
    stmts.push(env.DB.prepare(INSERT_WALLET_JSON).bind(character.character_id, createdAt, JSON.stringify(rows.slice(i, i + 300))));
  }
  stmts.push(env.DB.prepare('UPDATE characters SET last_wallet_sync_at = ?, updated_at = ? WHERE id = ?').bind(toDb(now), createdAt, character.id));
  const results = await env.DB.batch(stmts);
  for (let i = 0; i < results.length - 1; i++) inserted += results[i].meta?.changes || 0;
  character.last_wallet_sync_at = toDb(now);
  return { character: character.character_name, status: 'synced', inserted };
}

export async function characterById(db, characterId) {
  return first(db, 'SELECT * FROM characters WHERE character_id = ?', characterId);
}
