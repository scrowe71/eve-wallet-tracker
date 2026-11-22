// Session building, loot-to-session matching and loot totals.
//
// Same rules as the Python app (session_builder.py, session_resolver.py,
// loot_valuation.py), rewritten to use a handful of set-based D1 statements
// instead of one query per row.

import { settings } from './config.js';
import { all, OWNED } from './db.js';
import { classifyWalletEntry } from './esi.js';
import { parseDb, tzOffsetMs, safeTz, nowDb, toDb } from './time.js';

export const SUPPORTED_ACTIVITIES = ['Ratting', 'Incursions', 'Missions'];

/**
 * A session ends at its last wallet entry or its last loot entry, whichever is later.
 * ESI's wallet journal lags behind the game, so loot logged while still ratting
 * (and attached to this session) is often the newest sign of activity.
 * Recomputed from the rows each time, so deleting loot shrinks it back.
 */
const END_FROM_ACTIVITY = (sid) => `end_time = MAX(
          COALESCE((SELECT MAX(w.entry_date) FROM wallet_entries w WHERE w.session_id = ${sid}), end_time),
          COALESCE((SELECT MAX(l2.loot_date) FROM loot_entries l2 WHERE l2.session_id = ${sid}), ''))`;

/** A ratting bounty payout covers the 20-minute cycle before it. */
export const BOUNTY_CYCLE_MS = 20 * 60 * 1000;
const isBountyRow = (e) => {
  const ref = String(e.ref_type || '').toLowerCase();
  const desc = String(e.description || '').toLowerCase();
  return ref === 'bounty_prizes' || desc.includes('bounty prizes');
};

/** Statement: recompute one session's loot_value and total_value from its loot rows. */
export function recalcSessionLootStmt(db, sessionId) {
  return db.prepare(`
    UPDATE sessions
    SET loot_value = (SELECT COALESCE(SUM(calculated_value), 0) FROM loot_entries WHERE session_id = ?1),
        total_value = COALESCE(wallet_income, 0) + (SELECT COALESCE(SUM(calculated_value), 0) FROM loot_entries WHERE session_id = ?1),
        ${END_FROM_ACTIVITY('?1')}
    WHERE id = ?1`).bind(sessionId);
}

/** Statement: recompute loot/total for every session of a user. */
function recalcAllUserSessionsStmt(db, userId) {
  return db.prepare(`
    UPDATE sessions
    SET loot_value = (SELECT COALESCE(SUM(l.calculated_value), 0) FROM loot_entries l WHERE l.session_id = sessions.id),
        total_value = COALESCE(wallet_income, 0) + (SELECT COALESCE(SUM(l.calculated_value), 0) FROM loot_entries l WHERE l.session_id = sessions.id),
        ${END_FROM_ACTIVITY('sessions.id')}
    WHERE ${OWNED('source_character_id')}`).bind(userId);
}

/** Load the data the resolver needs for one user. */
export async function loadResolverContext(db, userId) {
  const characterIds = (await all(db, 'SELECT character_id FROM characters WHERE user_id = ?', userId)).map((r) => Number(r.character_id));
  const sessions = await all(db,
    `SELECT id, activity_type, source_character_id, start_time, end_time FROM sessions WHERE ${OWNED('source_character_id')}`, userId);
  for (const s of sessions) {
    s._start = parseDb(s.start_time);
    s._end = parseDb(s.end_time);
    s.source_character_id = Number(s.source_character_id);
  }
  return { characterIds, sessions };
}

/**
 * Pick one session for a loot entry, consistently for every loot import path:
 * 1. Session containing eventTime for the selected character.
 * 2. Session containing eventTime for any of the user's characters.
 * 3. Most recently ended session, if it ended within the session timeout.
 * 4. Most recently ended session as a final fallback.
 */
export function resolveCurrentSession(ctx, env, characterId, eventTimeMs = null, activityType = null) {
  const t = eventTimeMs ?? Date.now();
  if (!ctx.characterIds.length) return null;
  const pool = activityType ? ctx.sessions.filter((s) => s.activity_type === activityType) : ctx.sessions;
  const latestEnd = (rows) => rows.reduce((best, s) => (best === null || s._end > best._end ? s : best), null);

  if (characterId !== null && characterId !== undefined && ctx.characterIds.includes(Number(characterId))) {
    const exact = latestEnd(pool.filter((s) => s.source_character_id === Number(characterId) && s._start <= t && s._end >= t));
    if (exact) return exact;
  }
  const exactAny = latestEnd(pool.filter((s) => s._start <= t && s._end >= t));
  if (exactAny) return exactAny;

  const latest = latestEnd(pool.filter((s) => s._end <= t));
  if (latest) {
    const timeout = Math.max(Math.trunc(settings(env).SESSION_TIMEOUT_HOURS), 0) * 3600 * 1000;
    if (t - latest._end <= timeout) return latest;
  }
  return latestEnd(pool);
}

/** Attach loot rows that have no session yet. Returns how many were repaired. */
export async function repairUnmatchedLoot(env, userId) {
  const db = env.DB;
  const rows = await all(db,
    `SELECT id, character_id, loot_date, activity_type FROM loot_entries
     WHERE ${OWNED('character_id')} AND session_id IS NULL ORDER BY loot_date ASC`, userId);
  if (!rows.length) return 0;
  const ctx = await loadResolverContext(db, userId);
  const updates = [];
  const touched = new Set();
  for (const row of rows) {
    const match = resolveCurrentSession(ctx, env, row.character_id, parseDb(row.loot_date), row.activity_type);
    if (match) {
      updates.push({ id: row.id, s: match.id, t: match.activity_type });
      touched.add(match.id);
    }
  }
  if (!updates.length) return 0;
  const stmts = [updateLootSessionsStmt(db, updates)];
  for (const sid of touched) stmts.push(recalcSessionLootStmt(db, sid));
  await db.batch(stmts);
  return updates.length;
}

/** Statement: set session_id/activity_type on many loot rows at once. */
function updateLootSessionsStmt(db, updates) {
  return db.prepare(`
    UPDATE loot_entries
    SET session_id = (SELECT json_extract(j.value, '$.s') FROM json_each(?1) j WHERE json_extract(j.value, '$.id') = loot_entries.id),
        activity_type = COALESCE((SELECT json_extract(j.value, '$.t') FROM json_each(?1) j WHERE json_extract(j.value, '$.id') = loot_entries.id), activity_type)
    WHERE id IN (SELECT json_extract(value, '$.id') FROM json_each(?1))`).bind(JSON.stringify(updates));
}

/**
 * Rebuild generated sessions from existing wallet rows.
 *
 * ESI timestamps stay stored in UTC. The session gap (SESSION_TIMEOUT_HOURS) is
 * measured on wall-clock time in the user's browser timezone, as before.
 */
export async function rebuildSessions(env, userId, timezoneName = 'UTC') {
  const db = env.DB;
  const tz = safeTz(timezoneName);
  const timeoutMs = settings(env).SESSION_TIMEOUT_HOURS * 3600 * 1000;

  const entries = await all(db,
    `SELECT id, character_id, entry_date, ref_type, description, amount, activity_type
     FROM wallet_entries WHERE ${OWNED('character_id')} ORDER BY entry_date, id`, userId);

  // 1. Reclassify existing rows so rule changes apply to already-synced data.
  const changed = new Map(); // new activity (or '') -> [ids]
  for (const e of entries) {
    const activity = classifyWalletEntry(e.ref_type, e.description);
    if ((activity ?? null) !== (e.activity_type ?? null)) {
      const key = activity ?? '';
      if (!changed.has(key)) changed.set(key, []);
      changed.get(key).push(e.id);
    }
    e.activity_type = activity;
  }

  // 2. Group each character's entries per activity, splitting on gaps >= timeout.
  const offsetCache = new Map();
  const localMs = (ms) => {
    const hour = Math.floor(ms / 3600000);
    let off = offsetCache.get(hour);
    if (off === undefined) {
      off = tzOffsetMs(ms, tz);
      offsetCache.set(hour, off);
    }
    return ms + off;
  };

  const byKey = new Map();
  for (const e of entries) {
    if (!SUPPORTED_ACTIVITIES.includes(e.activity_type)) continue;
    const key = `${e.character_id}|${e.activity_type}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(e);
  }

  const newSessions = [];
  const flush = (group, characterId, activity) => {
    if (!group.length) return;
    let start = group[0];
    let end = group[0];
    let income = 0;
    for (const e of group) {
      if (e._ms < start._ms) start = e;
      if (e._ms > end._ms) end = e;
      income += Number(e.amount || 0);
    }
    // Ratting sessions start one bounty cycle (20 minutes) before the first bounty payout,
    // because that payout is for the ratting done in those 20 minutes.
    const startAt = activity === 'Ratting' && isBountyRow(start) ? toDb(start._ms - BOUNTY_CYCLE_MS) : start.entry_date;
    newSessions.push({ c: Number(characterId), a: activity, s: startAt, e: end.entry_date, w: income });
  };
  for (const [key, list] of byKey) {
    const [characterId, activity] = key.split('|');
    for (const e of list) e._ms = parseDb(e.entry_date);
    list.sort((x, y) => x._ms - y._ms || x.id - y.id);
    let current = [];
    let prevLocal = null;
    for (const e of list) {
      const local = localMs(e._ms);
      if (prevLocal !== null && local - prevLocal >= timeoutMs) {
        flush(current, characterId, activity);
        current = [];
      }
      current.push(e);
      prevLocal = local;
    }
    flush(current, characterId, activity);
  }

  // 3. Replace the user's sessions and point wallet rows at them.
  const created = nowDb();
  const stmts = [];
  for (const [activity, ids] of changed) {
    for (let i = 0; i < ids.length; i += 2000) {
      stmts.push(db.prepare('UPDATE wallet_entries SET activity_type = ?1 WHERE id IN (SELECT value FROM json_each(?2))')
        .bind(activity === '' ? null : activity, JSON.stringify(ids.slice(i, i + 2000))));
    }
  }
  // D1 enforces foreign keys, so detach wallet and loot rows before deleting the sessions they point at.
  stmts.push(db.prepare(`UPDATE wallet_entries SET session_id = NULL WHERE ${OWNED('character_id')}`).bind(userId));
  stmts.push(db.prepare(`UPDATE loot_entries SET session_id = NULL WHERE ${OWNED('character_id')}`).bind(userId));
  stmts.push(db.prepare(`DELETE FROM sessions WHERE ${OWNED('source_character_id')}`).bind(userId));
  for (let i = 0; i < newSessions.length; i += 500) {
    stmts.push(db.prepare(`
      INSERT INTO sessions (activity_type, session_type, source_character_id, start_time, end_time, fleet_size,
                            apply_fleet_multiplier, wallet_income, loot_value, total_value, notes, created_at)
      SELECT json_extract(value, '$.a'), 'Single Character', json_extract(value, '$.c'), json_extract(value, '$.s'),
             json_extract(value, '$.e'), 1, 0, json_extract(value, '$.w'), 0, json_extract(value, '$.w'), NULL, ?1
      FROM json_each(?2)`).bind(created, JSON.stringify(newSessions.slice(i, i + 500))));
  }
  // Sessions for one character and activity never overlap, so each wallet row
  // belongs to exactly the session whose time span contains it.
  stmts.push(db.prepare(`
    UPDATE wallet_entries
    SET session_id = (
      SELECT s.id FROM sessions s
      WHERE s.source_character_id = wallet_entries.character_id
        AND s.activity_type = wallet_entries.activity_type
        AND s.start_time <= wallet_entries.entry_date AND s.end_time >= wallet_entries.entry_date
      ORDER BY s.start_time DESC LIMIT 1)
    WHERE ${OWNED('character_id')} AND activity_type IN ('Ratting', 'Incursions', 'Missions')`).bind(userId));
  await db.batch(stmts);

  // 4. Reattach loot to the rebuilt sessions so rebuilds never orphan loot.
  await reattachAndRecalculateLoot(env, userId);
  return newSessions.length;
}

/** Attach dated loot rows to matching rebuilt sessions and refresh totals. */
export async function reattachAndRecalculateLoot(env, userId) {
  const db = env.DB;
  const ctx = await loadResolverContext(db, userId);
  const loot = await all(db, `SELECT id, character_id, loot_date, activity_type FROM loot_entries WHERE ${OWNED('character_id')}`, userId);
  const updates = [];
  for (const row of loot) {
    const match = resolveCurrentSession(ctx, env, row.character_id, parseDb(row.loot_date), row.activity_type);
    updates.push({ id: row.id, s: match ? match.id : null, t: match ? match.activity_type : null });
  }
  const stmts = [];
  for (let i = 0; i < updates.length; i += 1000) stmts.push(updateLootSessionsStmt(db, updates.slice(i, i + 1000)));
  stmts.push(recalcAllUserSessionsStmt(db, userId));
  await db.batch(stmts);
}
