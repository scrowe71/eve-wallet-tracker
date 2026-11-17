// Loot pages (was the loot part of routers/simple_pages.py).

import { settings } from '../config.js';
import { all, first, characterMap, getSetting, OWNED } from '../db.js';
import { pyFloat } from '../html.js';
import { page, redirect, text, pyFloatParse, pyIntParse } from '../http.js';
import { ALL_PRICE_SOURCES, PricingError, calculateLootValue, getJitaPrice, janicePriceItems, resolveInventoryTypes } from '../pricing.js';
import { loadResolverContext, recalcSessionLootStmt, repairUnmatchedLoot, resolveCurrentSession } from '../sessions.js';
import { nowDb } from '../time.js';
import { lootPage } from '../views/pages.js';

async function defaults(env) {
  const cfg = settings(env);
  return {
    source: await getSetting(env.DB, 'loot_price_source', cfg.DEFAULT_LOOT_PRICE_SOURCE),
    pct: await getSetting(env.DB, 'loot_valuation_percentage', pyFloat(cfg.DEFAULT_LOOT_PERCENTAGE)),
  };
}

async function lootContext(req, extra = {}) {
  const { env, session, userId } = req;
  const { rows: characters, map } = await characterMap(env.DB, userId);
  const entries = await all(env.DB, `SELECT * FROM loot_entries WHERE ${OWNED('character_id')} ORDER BY created_at DESC LIMIT 200`, userId);
  const d = await defaults(env);
  const preview = extra.preview_items || [];
  return {
    characters,
    character_map: map,
    entries,
    default_source: d.source,
    default_pct: d.pct,
    price_sources: ALL_PRICE_SOURCES,
    timezone_name: session.timezone(),
    form_values: extra.form_values || {},
    preview_items: preview,
    parse_errors: extra.parse_errors || [],
    calculated: !!extra.calculated,
    preview_total: preview.reduce((a, r) => a + Number(r.calculated_value || 0), 0),
  };
}

const ownedCharacter = (db, userId, characterId) =>
  first(db, 'SELECT * FROM characters WHERE user_id = ? AND character_id = ?', userId, characterId);

/** Common form fields; the percentage falls back to the saved default when blank. */
async function readCommon(env, form) {
  const d = await defaults(env);
  const characterId = form.get('character_id') ? pyIntParse(form.get('character_id')) : 0;
  let priceSource = String(form.get('price_source') || d.source);
  const pctRaw = form.get('valuation_percentage');
  const pct = pyFloatParse(pctRaw ? pctRaw : d.pct);
  if (!ALL_PRICE_SOURCES.includes(priceSource)) priceSource = d.source;
  return { characterId, priceSource, pct };
}

/**
 * Parse pasted loot lines:
 *   Item Name<TAB>Quantity
 *   Item Name    Quantity
 *   Item Name<TAB>Quantity<TAB>Jita Price  (optional)
 */
export function parseLootLines(rawText) {
  const items = [];
  const errors = [];
  const lines = String(rawText || '').split(/\r\n|\r|\n/);
  lines.forEach((original, i) => {
    const lineNo = i + 1;
    const line = original.trim();
    if (!line) return;
    const parts = line.split('\t').map((p) => p.trim()).filter(Boolean);
    let itemName;
    let qtyText;
    let priceText = '';
    if (parts.length >= 2) {
      [itemName, qtyText] = parts;
      priceText = parts[2] || '';
    } else {
      // A trailing whole number is the quantity; otherwise the whole line is the
      // name (keeps names like "Imperial Navy 1600mm Steel Plates" intact).
      const m = line.match(/^(.*\S)\s+(\S+)$/);
      if (m && /^\d+$/.test(m[2].replace(/,/g, ''))) {
        itemName = m[1].trim();
        qtyText = m[2].trim();
      } else {
        itemName = line;
        qtyText = '1';
      }
    }
    let quantity;
    try {
      quantity = pyIntParse(qtyText.replace(/,/g, ''));
      if (quantity < 1) throw new Error();
    } catch {
      errors.push(`Line ${lineNo}: quantity must be a whole number: ${original}`);
      return;
    }
    let jitaPrice = 0;
    if (priceText) {
      try {
        jitaPrice = pyFloatParse(priceText.replace(/,/g, ''));
        if (jitaPrice < 0) throw new Error();
      } catch {
        errors.push(`Line ${lineNo}: Jita price must be numeric if provided: ${original}`);
        return;
      }
    }
    if (!itemName) {
      errors.push(`Line ${lineNo}: item name is blank: ${original}`);
      return;
    }
    items.push({ item_name: itemName, quantity, jita_price: jitaPrice });
  });
  if (!items.length && !errors.length) errors.push('Paste at least one item line.');
  return { items, errors };
}

/** "125000000", "125,000,000", "125000000 ISK", "125m", "1.2b", "750k" */
export function parseManualIskAmount(rawValue) {
  let t = String(rawValue || '').trim().toLowerCase().replace(/,/g, '').replace(/isk/g, '').trim();
  if (!t) throw new Error('Amount is required.');
  let multiplier = 1;
  if (t.endsWith('b')) { multiplier = 1e9; t = t.slice(0, -1).trim(); }
  else if (t.endsWith('m')) { multiplier = 1e6; t = t.slice(0, -1).trim(); }
  else if (t.endsWith('k')) { multiplier = 1e3; t = t.slice(0, -1).trim(); }
  const amount = pyFloatParse(t) * multiplier;
  if (amount <= 0) throw new Error('Amount must be greater than zero.');
  return amount;
}

export async function lootIndex(req) {
  await repairUnmatchedLoot(req.env, req.userId);
  return page(req.session, lootPage(await lootContext(req)));
}

export async function lootPreview(req) {
  const { env, session, userId } = req;
  const form = await req.request.formData();
  const { characterId, priceSource, pct } = await readCommon(env, form);
  const lootText = String(form.get('loot_text') || '');
  const character = await ownedCharacter(env.DB, userId, characterId);
  if (!character) return text('Character is not linked to the logged-in user.', 403);

  const { items, errors } = parseLootLines(lootText);
  const preview = items.map((row) => ({
    character_id: characterId,
    character_name: character.character_name,
    item_name: row.item_name,
    quantity: row.quantity,
    jita_price: row.jita_price,
    price_source: priceSource,
    valuation_percentage: pct,
    calculated_value: calculateLootValue(row.quantity, row.jita_price, pct),
  }));
  return page(session, lootPage(await lootContext(req, {
    preview_items: preview,
    parse_errors: errors,
    form_values: { character_id: characterId, loot_text: lootText, price_source: priceSource, valuation_percentage: pct },
    calculated: false,
  })));
}

export async function lootCalculate(req) {
  const { env, session, userId } = req;
  const form = await req.request.formData();
  const { characterId, priceSource, pct } = await readCommon(env, form);
  const itemNames = form.getAll('item_name').map((x) => String(x).trim());
  const quantities = form.getAll('quantity');
  const character = await ownedCharacter(env.DB, userId, characterId);
  if (!character) return text('Character is not linked to the logged-in user.', 403);

  const errors = [];
  const preview = [];
  let janice = new Map();
  if (priceSource === 'Janice Buy') {
    try {
      janice = await janicePriceItems(env, itemNames.filter(Boolean));
    } catch (err) {
      errors.push(String(err.message || err));
    }
  }
  // Resolve every item name to a type ID with one ESI call.
  let resolved = null;
  let resolveError = null;
  if (priceSource !== 'Janice Buy') {
    try {
      resolved = await resolveInventoryTypes(itemNames.filter(Boolean));
    } catch (err) {
      resolveError = err;
    }
  }

  for (let idx = 0; idx < itemNames.length; idx++) {
    const itemName = itemNames[idx];
    if (!itemName) continue;
    let quantity;
    try {
      quantity = pyIntParse(String(quantities[idx] ?? '').replace(/,/g, ''));
      if (quantity < 1) throw new Error();
    } catch {
      errors.push(`Row ${idx + 1}: quantity must be a whole number.`);
      quantity = 0;
    }
    let typeId = null;
    let jitaPrice = 0;
    let priceNote = '';
    if (itemName && quantity && !errors.length) {
      try {
        if (priceSource === 'Janice Buy') {
          const priced = janice.get(itemName.toLowerCase());
          if (!priced) throw new PricingError('Item was not returned by Janice.');
          typeId = priced.type_id;
          jitaPrice = priced.buy_price;
          priceNote = 'Janice Jita immediate buy';
        } else {
          if (resolveError) throw resolveError;
          const match = resolved.get(itemName.toLowerCase());
          if (!match) throw new PricingError(`could not resolve item name: ${itemName}`);
          typeId = match.type_id;
          const priced = await getJitaPrice(typeId, priceSource);
          jitaPrice = priced.price;
          priceNote = priced.location_note;
        }
      } catch (err) {
        if (err instanceof PricingError) errors.push(`Row ${idx + 1}: ${itemName}: ${err.message}`);
        else errors.push(`Row ${idx + 1}: ${itemName}: pricing failed: ${err.message || err}`);
      }
    }
    preview.push({
      character_id: characterId,
      character_name: character.character_name,
      item_name: itemName,
      type_id: typeId,
      quantity,
      jita_price: jitaPrice,
      price_note: priceNote,
      price_source: priceSource,
      valuation_percentage: pct,
      calculated_value: calculateLootValue(quantity, jitaPrice, pct),
    });
  }
  return page(session, lootPage(await lootContext(req, {
    preview_items: preview,
    parse_errors: errors,
    form_values: { character_id: characterId, price_source: priceSource, valuation_percentage: pct },
    calculated: errors.length === 0,
  })));
}

const INSERT_LOOT = `INSERT INTO loot_entries (session_id, character_id, loot_date, activity_type, item_name, type_id, quantity,
  price_source, jita_price, valuation_percentage, calculated_value, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export async function lootManual(req) {
  const { env, session, userId } = req;
  const db = env.DB;
  const form = await req.request.formData();
  let characterId = 0;
  try {
    characterId = form.get('manual_character_id') ? pyIntParse(form.get('manual_character_id')) : 0;
  } catch {
    characterId = 0;
  }
  const itemName = String(form.get('manual_description') || 'Manual Loot Value').trim() || 'Manual Loot Value';
  const rawAmount = String(form.get('manual_isk_amount') || '');
  if (!(await ownedCharacter(db, userId, characterId))) return text('Character is not linked to the logged-in user.', 403);

  let value;
  try {
    value = parseManualIskAmount(rawAmount);
  } catch (err) {
    return page(session, lootPage(await lootContext(req, {
      parse_errors: [`Manual loot amount error: ${err.message}`],
      form_values: { manual_character_id: characterId, manual_description: itemName, manual_isk_amount: rawAmount },
    })), 400);
  }

  const lootDate = nowDb();
  const ctx = await loadResolverContext(db, userId);
  const match = resolveCurrentSession(ctx, env, characterId, Date.now());
  const stmts = [db.prepare(INSERT_LOOT).bind(
    match ? match.id : null, characterId, lootDate, match ? match.activity_type : null, itemName, null, 1,
    'Manual ISK', value, 100, value, nowDb())];
  if (match) stmts.push(recalcSessionLootStmt(db, match.id));
  await db.batch(stmts);
  return redirect('/loot');
}

export async function lootAdd(req) {
  const { env, userId } = req;
  const db = env.DB;
  const form = await req.request.formData();
  const { characterId, priceSource, pct } = await readCommon(env, form);
  const itemNames = form.getAll('item_name');
  const typeIds = form.getAll('type_id');
  const quantities = form.getAll('quantity');
  const prices = form.getAll('jita_price');
  if (!(await ownedCharacter(db, userId, characterId))) return text('Character is not linked to the logged-in user.', 403);

  const lootDate = nowDb();
  const ctx = await loadResolverContext(db, userId);
  const match = resolveCurrentSession(ctx, env, characterId, Date.now());
  const rows = [];
  for (let idx = 0; idx < itemNames.length; idx++) {
    const itemName = String(itemNames[idx]).trim();
    if (!itemName) continue;
    const quantity = pyIntParse(String(quantities[idx]).replace(/,/g, ''));
    const typeText = idx < typeIds.length ? String(typeIds[idx] || '') : '';
    const typeId = /^\d+$/.test(typeText) ? parseInt(typeText, 10) : null;
    const jitaPrice = pyFloatParse(String(prices[idx]).replace(/,/g, ''));
    rows.push({
      s: match ? match.id : null, t: match ? match.activity_type : null, n: itemName, y: typeId, q: quantity,
      p: jitaPrice, v: calculateLootValue(quantity, jitaPrice, pct),
    });
  }
  if (rows.length) {
    const now = nowDb();
    const stmts = [db.prepare(`
      INSERT INTO loot_entries (session_id, character_id, loot_date, activity_type, item_name, type_id, quantity,
        price_source, jita_price, valuation_percentage, calculated_value, created_at)
      SELECT json_extract(value, '$.s'), ?1, ?2, json_extract(value, '$.t'), json_extract(value, '$.n'), json_extract(value, '$.y'),
             json_extract(value, '$.q'), ?3, json_extract(value, '$.p'), ?4, json_extract(value, '$.v'), ?5
      FROM json_each(?6)`).bind(characterId, lootDate, priceSource, pct, now, JSON.stringify(rows))];
    if (match) stmts.push(recalcSessionLootStmt(db, match.id));
    await db.batch(stmts);
  }
  return redirect('/loot');
}

export async function lootDelete(req, lootIdText) {
  const { env, userId } = req;
  const db = env.DB;
  const lootId = Number(lootIdText);
  if (!Number.isInteger(lootId)) return redirect('/loot');
  const entry = await first(db, `SELECT * FROM loot_entries WHERE id = ? AND ${OWNED('character_id')}`, lootId, userId);
  if (!entry) return redirect('/loot');
  const stmts = [db.prepare('DELETE FROM loot_entries WHERE id = ?').bind(lootId)];
  if (entry.session_id) stmts.push(recalcSessionLootStmt(db, entry.session_id));
  await db.batch(stmts);
  return redirect('/loot');
}

