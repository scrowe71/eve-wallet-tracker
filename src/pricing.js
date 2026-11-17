// Loot pricing: Jita buy/sell from public ESI market orders, or Janice immediate buy.

import { settings, USER_AGENT, ESI_BASE, ESI_COMPAT_DATE } from './config.js';

const THE_FORGE_REGION_ID = 10000002;
const JITA_SYSTEM_ID = 30000142;
const JITA_44_STATION_ID = 60003760;

export const SUPPORTED_PRICE_SOURCES = ['Jita Buy', 'Jita Sell'];
export const ALL_PRICE_SOURCES = [...SUPPORTED_PRICE_SOURCES, 'Janice Buy'];

export class PricingError extends Error {}

const esiHeaders = { 'User-Agent': USER_AGENT, Accept: 'application/json', 'X-Compatibility-Date': ESI_COMPAT_DATE };

/**
 * Resolve item names to type IDs with one /universe/ids/ call.
 * Returns Map(lowercased name -> {item_name, type_id}). Names that can't be
 * resolved are missing from the map.
 */
export async function resolveInventoryTypes(names) {
  const clean = [...new Set(names.map((n) => String(n || '').trim()).filter(Boolean))];
  const out = new Map();
  if (!clean.length) return out;
  for (let i = 0; i < clean.length; i += 500) {
    const chunk = clean.slice(i, i + 500);
    const r = await fetch(`${ESI_BASE}/universe/ids/?language=en`, {
      method: 'POST',
      headers: { ...esiHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(chunk),
    });
    if (r.status === 400 || r.status === 404) continue;
    if (!r.ok) throw new PricingError(`ESI name lookup returned HTTP ${r.status}`);
    const data = (await r.json()) || {};
    for (const match of data.inventory_types || []) {
      if (match.id && match.name) out.set(String(match.name).trim().toLowerCase(), { item_name: match.name, type_id: Number(match.id) });
    }
  }
  return out;
}

async function fetchMarketOrders(typeId, orderType) {
  const orders = [];
  let page = 1;
  let pages = 1;
  do {
    const url = `${ESI_BASE}/markets/${THE_FORGE_REGION_ID}/orders/?order_type=${orderType}&type_id=${typeId}&page=${page}`;
    const r = await fetch(url, { headers: esiHeaders });
    if (r.status === 404) return [];
    if (!r.ok) throw new PricingError(`ESI market orders returned HTTP ${r.status}`);
    orders.push(...((await r.json()) || []));
    pages = parseInt(r.headers.get('X-Pages') || '1', 10) || 1;
    page += 1;
  } while (page <= pages);
  return orders;
}

/**
 * Highest Jita buy or lowest Jita sell for a type. Prefers Jita 4-4 orders, then
 * the Jita system, then anywhere in The Forge.
 */
const priceCache = new Map(); // `${typeId}|${source}` -> [fetchedAt, result]; lives as long as the Worker instance
const CACHE_MS = 20 * 60 * 1000;

export async function getJitaPrice(typeId, priceSource) {
  const source = priceSource === 'Jita Sell' ? 'Jita Sell' : 'Jita Buy';
  const cacheKey = `${typeId}|${source}`;
  const cached = priceCache.get(cacheKey);
  if (cached && Date.now() - cached[0] < CACHE_MS) return cached[1];
  const orders = await fetchMarketOrders(typeId, source === 'Jita Buy' ? 'buy' : 'sell');
  if (!orders.length) throw new PricingError(`no ${source.toLowerCase()} market orders found`);
  const station = orders.filter((o) => Number(o.location_id || 0) === JITA_44_STATION_ID);
  const system = orders.filter((o) => Number(o.system_id || 0) === JITA_SYSTEM_ID);
  const candidates = station.length ? station : system.length ? system : orders;
  const note = station.length ? 'Jita 4-4' : system.length ? 'Jita system' : 'The Forge fallback';
  const prices = candidates.map((o) => Number(o.price || 0));
  const price = source === 'Jita Buy' ? Math.max(...prices) : Math.min(...prices);
  const result = { type_id: Number(typeId), price_source: source, price, order_count: candidates.length, location_note: note };
  priceCache.set(cacheKey, [Date.now(), result]);
  return result;
}

/** Janice Jita immediate-buy prices. Returns Map(lowercased name -> {type_id, name, buy_price}). */
export async function janicePriceItems(env, itemNames) {
  const apiKey = settings(env).JANICE_API_KEY;
  if (!apiKey) throw new PricingError('JANICE_API_KEY is not configured. Add it as a secret in the Worker settings.');
  const clean = itemNames.map((n) => String(n || '').trim()).filter(Boolean);
  const result = new Map();
  if (!clean.length) return result;
  let r;
  try {
    r = await fetch('https://janice.e-351.com/api/rest/v2/pricer?market=2', {
      method: 'POST',
      headers: { 'X-ApiKey': apiKey, 'Content-Type': 'text/plain', Accept: 'application/json', 'User-Agent': USER_AGENT },
      body: clean.join('\n'),
    });
  } catch (err) {
    throw new PricingError(`Janice request failed: ${err.message}`);
  }
  if (r.status >= 400) {
    const detail = (await r.text()).trim().slice(0, 300);
    throw new PricingError(`Janice returned HTTP ${r.status}: ${detail || 'no response details'}`);
  }
  let payload;
  try {
    payload = await r.json();
  } catch {
    throw new PricingError(`Janice returned ${r.headers.get('content-type') || 'non-JSON data'} instead of JSON.`);
  }
  if (!Array.isArray(payload)) throw new PricingError('Janice returned an unexpected response format.');
  for (const row of payload) {
    if (!row || typeof row !== 'object') continue;
    const item = row.itemType || {};
    const name = String(item.name || '').trim();
    if (!name) continue;
    const buy = Number((row.immediatePrices || {}).buyPrice || 0) || 0;
    const typeId = item.eid !== undefined && item.eid !== null && !Number.isNaN(Number(item.eid)) ? Number(item.eid) : null;
    result.set(name.toLowerCase(), { type_id: typeId, name, buy_price: Math.max(buy, 0) });
  }
  return result;
}

export function calculateLootValue(quantity, jitaPrice, valuationPercentage) {
  const q = Math.max(Math.trunc(Number(quantity || 0)), 0);
  const p = Math.max(Number(jitaPrice || 0), 0);
  const pct = Math.max(Number(valuationPercentage || 0), 0);
  return q * p * (pct / 100);
}
