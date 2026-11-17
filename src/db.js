// Small D1 helpers.

export async function all(db, sql, ...params) {
  const { results } = await db.prepare(sql).bind(...params).all();
  return results || [];
}

export async function first(db, sql, ...params) {
  return (await db.prepare(sql).bind(...params).first()) ?? null;
}

export async function run(db, sql, ...params) {
  return db.prepare(sql).bind(...params).run();
}

/** Characters linked to a local user, ordered by name. */
export function userCharacters(db, userId) {
  return all(db, 'SELECT * FROM characters WHERE user_id = ? ORDER BY character_name', userId);
}

/** character_id -> character_name for a user. */
export async function characterMap(db, userId) {
  const rows = await userCharacters(db, userId);
  return { rows, map: new Map(rows.map((c) => [Number(c.character_id), c.character_name])) };
}

/**
 * SQL fragment that restricts a column to the user's characters without
 * binding one parameter per character (D1 allows 100 bound parameters).
 */
export const OWNED = (column) => `${column} IN (SELECT character_id FROM characters WHERE user_id = ?)`;

export async function getSetting(db, key, fallback) {
  const row = await first(db, 'SELECT value FROM app_settings WHERE key = ?', key);
  return row ? row.value : fallback;
}

export function setSettingStmt(db, key, value) {
  return db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, String(value));
}
