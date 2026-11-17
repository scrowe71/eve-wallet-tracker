// Dashboard, characters, wallet sync, timezone, settings and about pages.

import { settings } from '../config.js';
import { all, userCharacters, characterMap, getSetting, setSettingStmt } from '../db.js';
import { syncCharacterWallet } from '../esi.js';
import { buildFleetGroups } from '../fleet.js';
import { pyFloat } from '../html.js';
import { page, redirect, json, httpError } from '../http.js';
import { ALL_PRICE_SOURCES } from '../pricing.js';
import { rebuildSessions } from '../sessions.js';
import { parseDb, safeTz, dashboardRangeBoundsUtc, localDateBoundsToUtc } from '../time.js';
import { aboutPage, charactersPage, dashboardPage, settingsPage, syncPage } from '../views/pages.js';

// ---------- Dashboard ----------

export function rangeBounds(url, tz, defaultRange) {
  const rangeValue = url.searchParams.get('range') || defaultRange;
  if (rangeValue === 'custom') {
    const [start, end] = localDateBoundsToUtc(url.searchParams.get('start_date'), url.searchParams.get('end_date'), tz);
    const [, , abbrev] = dashboardRangeBoundsUtc('today', tz);
    return { start, end, abbrev, rangeValue };
  }
  const [start, end, abbrev] = dashboardRangeBoundsUtc(rangeValue, tz);
  return { start, end, abbrev, rangeValue };
}

export async function dashboard(req) {
  const { env, session, url, userId } = req;
  const tz = session.timezone();
  const { start, end, abbrev, rangeValue } = rangeBounds(url, tz, 'today');

  let sql = `SELECT s.* FROM sessions s JOIN characters c ON s.source_character_id = c.character_id WHERE c.user_id = ?`;
  const params = [userId];
  if (start) { sql += ' AND s.start_time >= ?'; params.push(start); }
  if (end) { sql += ' AND s.start_time <= ?'; params.push(end); }
  const sessions = await all(env.DB, sql, ...params);

  // Totals use the same fleet-session grouping as the Sessions page.
  const { map: characters } = await characterMap(env.DB, userId);
  const groups = buildFleetGroups(sessions, characters);
  const wallet = groups.reduce((a, g) => a + (g.wallet_income || 0), 0);
  const loot = groups.reduce((a, g) => a + (g.loot_value || 0), 0);
  const total = groups.reduce((a, g) => a + (g.total_value || 0), 0);
  const hours = groups.reduce((a, g) => a + Math.max((g.end_ms - g.start_ms) / 3600000, 0.01), 0);

  // Wallet income by activity plus a separate Loot Value line, so the rows add up to Total Value.
  const byActivity = new Map([['Ratting', 0], ['Incursions', 0], ['Missions', 0], ['Loot Value', loot]]);
  const contributions = new Map();
  for (const s of sessions) {
    const activity = s.activity_type || 'Unclassified';
    const walletValue = Number(s.wallet_income || 0);
    byActivity.set(activity, (byActivity.get(activity) || 0) + walletValue);
    const name = characters.get(Number(s.source_character_id)) ?? 'Unknown Character';
    if (!contributions.has(name)) {
      contributions.set(name, { character: name, total: 0, Ratting: 0, Incursions: 0, Missions: 0, 'Loot Value': 0 });
    }
    const row = contributions.get(name);
    row.total += Number(s.total_value || 0);
    row['Loot Value'] += Number(s.loot_value || 0);
    if (['Ratting', 'Incursions', 'Missions'].includes(activity)) row[activity] += walletValue;
  }

  return page(session, dashboardPage({
    selected_range: rangeValue,
    start_date: url.searchParams.get('start_date') || '',
    end_date: url.searchParams.get('end_date') || '',
    wallet, loot, total,
    isk_hour: hours ? total / hours : 0,
    session_count: groups.length,
    by_activity: byActivity,
    character_contributions: [...contributions.values()].sort((a, b) => b.total - a.total),
    timezone_name: tz,
    timezone_abbrev: abbrev,
  }));
}

// ---------- Characters ----------

export async function characters(req) {
  const rows = await userCharacters(req.env.DB, req.userId);
  return page(req.session, charactersPage({
    characters: rows,
    linked: req.url.searchParams.get('linked'),
    tz: req.session.timezone(),
  }));
}

// ---------- Wallet sync ----------

function statusFor(env, c) {
  const last = parseDb(c.last_wallet_sync_at);
  if (!last) return ['Ready', 'Now'];
  const next = last + settings(env).ESI_SYNC_COOLDOWN_MINUTES * 60000;
  if (Date.now() >= next) return ['Ready', 'Now'];
  const mins = Math.max(1, Math.floor((next - Date.now()) / 60000) + 1);
  return ['Cooldown', `${mins} min`];
}

async function syncStatusForUser(env, userId) {
  const chars = await userCharacters(env.DB, userId);
  const now = Date.now();
  const cooldown = settings(env).ESI_SYNC_COOLDOWN_MINUTES * 60000;
  let lastSync = null;
  let lastSyncText = null;
  let ready = 0;
  const remaining = [];
  for (const c of chars) {
    const last = parseDb(c.last_wallet_sync_at);
    if (!last) {
      ready += 1;
      remaining.push(0);
      continue;
    }
    if (lastSync === null || last > lastSync) {
      lastSync = last;
      lastSyncText = c.last_wallet_sync_at;
    }
    const left = Math.max(0, Math.trunc((last + cooldown - now) / 1000));
    remaining.push(left);
    if (left <= 0) ready += 1;
  }
  const auto = await getSetting(env.DB, `auto_sync_enabled:${userId}`, null);
  return {
    auto_enabled: auto === '1',
    allowed: ready > 0,
    seconds_remaining: remaining.length ? Math.min(...remaining) : 0,
    last_sync: lastSyncText ? `${String(lastSyncText).replace(' ', 'T')}Z` : null,
    ready_count: ready,
    character_count: chars.length,
  };
}

async function syncAllCharacters(env, userId) {
  const results = [];
  for (const c of await userCharacters(env.DB, userId)) {
    try {
      results.push(await syncCharacterWallet(env, c));
    } catch (err) {
      results.push({ character: c.character_name, status: 'error', inserted: 0, reason: String(err.message || err) });
    }
  }
  return results;
}

export async function apiSyncStatus(req) {
  const data = await syncStatusForUser(req.env, req.userId);
  return json({ ...data, authenticated: true });
}

export async function apiAutoToggle(req) {
  let payload = {};
  try {
    payload = await req.request.json();
  } catch {
    return httpError(400, 'Invalid JSON body');
  }
  await setSettingStmt(req.env.DB, `auto_sync_enabled:${req.userId}`, payload && payload.enabled ? '1' : '0').run();
  const data = await syncStatusForUser(req.env, req.userId);
  return json({ ...data, authenticated: true });
}

export async function apiAutoRun(req) {
  const { env, userId, session } = req;
  const status = await syncStatusForUser(env, userId);
  if (!status.allowed) return json({ ...status, authenticated: true, ran: false, reason: 'cooldown' });

  const results = await syncAllCharacters(env, userId);
  const insertedTotal = results.reduce((a, r) => a + (Number(r.inserted) || 0), 0);
  let sessionsCreated = 0;
  if (insertedTotal > 0) sessionsCreated = await rebuildSessions(env, userId, session.timezone());

  const fresh = await syncStatusForUser(env, userId);
  return json({
    ...fresh,
    authenticated: true,
    ran: true,
    inserted_total: insertedTotal,
    sessions_created: sessionsCreated,
    characters: results,
    message: insertedTotal ? 'Auto sync complete.' : 'Auto sync complete. No new wallet entries.',
  });
}

export async function syncPageHandler(req) {
  const { env, session, userId } = req;
  const chars = await userCharacters(env.DB, userId);
  let anyReady = false;
  const rows = chars.map((c) => {
    const [status, next] = statusFor(env, c);
    anyReady = anyReady || status === 'Ready';
    return { character: c, status, next_available: next };
  });
  return page(session, syncPage({ rows, any_ready: anyReady, results: session.pop('sync_results', null), tz: session.timezone() }));
}

export async function syncAll(req) {
  const { env, session, userId } = req;
  const results = await syncAllCharacters(env, userId);
  const created = await rebuildSessions(env, userId, session.timezone());
  session.set('sync_results', { characters: results, sessions_created: created });
  return redirect('/sync');
}

export async function rebuildSessionsOnly(req) {
  const created = await rebuildSessions(req.env, req.userId, req.session.timezone());
  req.session.set('sync_results', {
    mode: 'rebuild', sessions_created: created, characters: [],
    message: 'Sessions rebuilt from existing wallet data. No ESI sync was performed.',
  });
  return redirect('/sync');
}

// ---------- Timezone ----------

export async function setTimezone(req) {
  let name = '';
  try {
    name = String((await req.request.formData()).get('timezone_name') || '');
  } catch {
    // fall through to the check below
  }
  if (!name) return httpError(422, 'timezone_name is required');
  const tz = safeTz(name);
  req.session.set('timezone', tz);
  return json({ ok: true, timezone: tz });
}

// ---------- Settings / About ----------

export async function settingsHandler(req) {
  const cfg = settings(req.env);
  return page(req.session, settingsPage({
    price_sources: ALL_PRICE_SOURCES,
    loot_price_source: await getSetting(req.env.DB, 'loot_price_source', cfg.DEFAULT_LOOT_PRICE_SOURCE),
    loot_valuation_percentage: await getSetting(req.env.DB, 'loot_valuation_percentage', pyFloat(cfg.DEFAULT_LOOT_PERCENTAGE)),
  }));
}

export async function saveLootSettings(req) {
  const cfg = settings(req.env);
  const form = await req.request.formData();
  let source = String(form.get('price_source') || '');
  if (!ALL_PRICE_SOURCES.includes(source)) source = cfg.DEFAULT_LOOT_PRICE_SOURCE;
  const pct = Math.max(Number(form.get('valuation_percentage')) || 0, 0);
  await req.env.DB.batch([
    setSettingStmt(req.env.DB, 'loot_price_source', source),
    setSettingStmt(req.env.DB, 'loot_valuation_percentage', pyFloat(pct)),
  ]);
  return redirect('/settings');
}

export const about = (req) => page(req.session, aboutPage());

