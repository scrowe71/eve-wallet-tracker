// Raw data, sessions and reports (was routers/raw_data.py, routers/sessions.py and the reports part of simple_pages.py).

import { all, first, userCharacters, characterMap, OWNED } from '../db.js';
import { csvResponse, pyRound, pyNum } from '../csv.js';
import { buildFleetGroups, buildSessionChart, formatCharacterList } from '../fleet.js';
import { page, redirect, httpError, optInt } from '../http.js';
import { rebuildSessions } from '../sessions.js';
import { parseDb, formatLocal, formatUtc, localDateBoundsToUtc } from '../time.js';
import { rawDataPage, reportsPage, sessionDetailPage, sessionsPage } from '../views/pages.js';
import { rangeBounds } from './core.js';

// ---------- Raw data ----------

function rawParams(url) {
  const q = url.searchParams;
  return {
    character_id: optInt(q.get('character_id')),
    ref_type: q.get('ref_type') || null,
    activity_type: q.get('activity_type') || null,
    amount_filter: q.get('amount_filter') || 'all',
    start_date: q.get('start_date') || null,
    end_date: q.get('end_date') || null,
    search: q.get('search') || null,
  };
}

function walletQuery(userId, p, tz) {
  let where = 'c.user_id = ?';
  const params = [userId];
  if (p.character_id) { where += ' AND w.character_id = ?'; params.push(p.character_id); }
  if (p.ref_type) { where += ' AND w.ref_type = ?'; params.push(p.ref_type); }
  if (p.activity_type) {
    if (p.activity_type === 'Uncategorized') where += " AND (w.activity_type IS NULL OR w.activity_type = '')";
    else { where += ' AND w.activity_type = ?'; params.push(p.activity_type); }
  }
  const [start, end] = localDateBoundsToUtc(p.start_date, p.end_date, tz);
  if (start) { where += ' AND w.entry_date >= ?'; params.push(start); }
  if (end) { where += ' AND w.entry_date < ?'; params.push(end); }
  if (p.amount_filter === 'positive') where += ' AND w.amount > 0';
  else if (p.amount_filter === 'negative') where += ' AND w.amount < 0';
  else if (p.amount_filter === 'zero') where += ' AND w.amount = 0';
  if (p.search) {
    const like = `%${p.search.trim()}%`;
    where += ' AND (w.description LIKE ? OR w.ref_type LIKE ?)';
    params.push(like, like);
  }
  return {
    from: `FROM wallet_entries w JOIN characters c ON w.character_id = c.character_id WHERE ${where}`,
    params,
  };
}

export async function rawData(req) {
  const { env, session, url, userId } = req;
  const db = env.DB;
  const tz = session.timezone();
  const p = rawParams(url);
  const pageNo = Math.max(optInt(url.searchParams.get('page')) || 1, 1);
  const perPage = 100;

  const characters = await userCharacters(db, userId);
  const refTypes = (await all(db, `SELECT DISTINCT ref_type FROM wallet_entries WHERE ${OWNED('character_id')} ORDER BY ref_type`, userId)).map((r) => r.ref_type);
  const activityTypes = (await all(db, `SELECT DISTINCT activity_type FROM wallet_entries WHERE ${OWNED('character_id')} AND activity_type IS NOT NULL ORDER BY activity_type`, userId)).map((r) => r.activity_type);

  const q = walletQuery(userId, p, tz);
  const totalRows = (await first(db, `SELECT COUNT(*) AS n ${q.from}`, ...q.params)).n;
  const rows = await all(db,
    `SELECT w.*, c.character_name ${q.from} ORDER BY w.entry_date DESC, w.esi_journal_id DESC LIMIT ? OFFSET ?`,
    ...q.params, perPage, (pageNo - 1) * perPage);

  return page(session, rawDataPage({
    rows, characters,
    ref_types: refTypes,
    activity_types: activityTypes,
    params: {
      character_id: p.character_id || '',
      ref_type: p.ref_type || '',
      activity_type: p.activity_type || '',
      amount_filter: p.amount_filter,
      start_date: p.start_date || '',
      end_date: p.end_date || '',
      search: p.search || '',
    },
    page: pageNo,
    total_pages: Math.max(1, Math.ceil(totalRows / perPage)),
    total_rows: totalRows,
    per_page: perPage,
    timezone_name: tz,
  }));
}

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

export async function rawDataExport(req) {
  const { env, session, url, userId } = req;
  const tz = session.timezone();
  const q = walletQuery(userId, rawParams(url), tz);
  const rows = await all(env.DB, `SELECT w.*, c.character_name ${q.from} ORDER BY w.entry_date DESC, w.esi_journal_id DESC`, ...q.params);
  return csvResponse(`evewallet_raw_data_${stamp()}.csv`,
    ['Local Date', 'EVE Time UTC', 'Character', 'Ref Type', 'Description', 'Amount', 'Balance', 'Activity Type', 'Session ID', 'ESI Journal ID'],
    rows.map((e) => [
      formatLocal(e.entry_date, tz), formatUtc(e.entry_date), e.character_name, e.ref_type, e.description || '',
      pyNum(e.amount), e.balance !== null ? pyNum(e.balance) : '', e.activity_type || '', e.session_id || '', e.esi_journal_id,
    ]));
}

// ---------- Sessions ----------

export async function sessionsList(req) {
  const { env, session, userId } = req;
  const rows = await all(env.DB,
    `SELECT s.* FROM sessions s JOIN characters c ON s.source_character_id = c.character_id
     WHERE c.user_id = ? ORDER BY s.start_time DESC LIMIT 500`, userId);
  const { map } = await characterMap(env.DB, userId);
  return page(session, sessionsPage({ session_groups: buildFleetGroups(rows, map), tz: session.timezone() }));
}

export async function sessionsRebuild(req) {
  await rebuildSessions(req.env, req.userId, req.session.timezone());
  return redirect('/sessions');
}

function totalsByCharacter(walletEntries, lootEntries, characters) {
  const wallet = new Map();
  for (const e of walletEntries) {
    const name = characters.get(Number(e.character_id)) ?? String(e.character_id);
    wallet.set(name, (wallet.get(name) || 0) + Number(e.amount || 0));
  }
  const loot = new Map();
  for (const e of lootEntries) {
    const name = characters.get(Number(e.character_id)) ?? String(e.character_id ?? '');
    loot.set(name, (loot.get(name) || 0) + Number(e.calculated_value || 0));
  }
  return { wallet, loot };
}

export async function fleetSessionDetail(req) {
  const { env, session, url, userId } = req;
  const db = env.DB;
  const idsParam = url.searchParams.get('ids');
  if (idsParam === null) return httpError(422, 'ids is required');
  const parts = idsParam.split(',').filter((x) => x.trim());
  const sessionIds = parts.map((x) => Number(x.trim()));
  if (sessionIds.some((n) => !Number.isInteger(n))) return httpError(400, 'Invalid session id list');
  if (!sessionIds.length) return httpError(400, 'No sessions selected');

  const sessions = await all(db,
    `SELECT * FROM sessions WHERE id IN (SELECT value FROM json_each(?)) AND ${OWNED('source_character_id')} ORDER BY start_time ASC`,
    JSON.stringify(sessionIds), userId);
  if (!sessions.length) return httpError(404, 'Session not found');
  const { map: characters } = await characterMap(db, userId);
  const ids = JSON.stringify(sessions.map((s) => s.id));

  const walletEntries = await all(db,
    `SELECT * FROM wallet_entries WHERE session_id IN (SELECT value FROM json_each(?)) AND ${OWNED('character_id')}
     ORDER BY entry_date ASC, character_id ASC`, ids, userId);
  const lootEntries = await all(db,
    `SELECT * FROM loot_entries WHERE session_id IN (SELECT value FROM json_each(?)) AND ${OWNED('character_id')}
     ORDER BY loot_date ASC, character_id ASC`, ids, userId);

  const startMs = Math.min(...sessions.map((s) => parseDb(s.start_time)));
  const endMs = Math.max(...sessions.map((s) => parseDb(s.end_time)));
  const walletIncome = sessions.reduce((a, s) => a + Number(s.wallet_income || 0), 0);
  const lootValue = sessions.reduce((a, s) => a + Number(s.loot_value || 0), 0);
  const totalValue = walletIncome + lootValue;
  const combined = {
    id: idsParam,
    activity_type: sessions[0].activity_type,
    session_type: sessions.length > 1 ? 'Fleet Session' : 'Single Character',
    source_character_id: sessions.length > 1 ? null : sessions[0].source_character_id,
    start_time: startMs,
    end_time: endMs,
    wallet_income: walletIncome,
    loot_value: lootValue,
    total_value: totalValue,
  };
  const { wallet, loot } = totalsByCharacter(walletEntries, lootEntries, characters);
  const durationHours = Math.max((endMs - startMs) / 1000, 0) / 3600;

  return page(session, sessionDetailPage({
    session: combined,
    session_label: sessions.length > 1 ? `Fleet Session (${sessions.length} character${sessions.length !== 1 ? 's' : ''})` : `Session #${sessions[0].id}`,
    character_label: formatCharacterList(sessions, characters),
    wallet_entries: walletEntries,
    loot_entries: lootEntries,
    characters,
    wallet_by_character: wallet,
    loot_by_character: loot,
    duration_hours: durationHours,
    isk_per_hour: durationHours > 0 ? totalValue / durationHours : 0,
    session_chart: buildSessionChart(combined, walletEntries, lootEntries),
    timezone_name: session.timezone(),
  }));
}

export async function sessionDetail(req, sessionIdText) {
  const { env, session, userId } = req;
  const db = env.DB;
  const sessionId = Number(sessionIdText);
  if (!Number.isInteger(sessionId)) return httpError(422, 'session_id must be an integer');
  const { map: characters } = await characterMap(db, userId);
  const s = await first(db, `SELECT * FROM sessions WHERE id = ? AND ${OWNED('source_character_id')}`, sessionId, userId);
  if (!s) return httpError(404, 'Session not found');

  const walletEntries = await all(db,
    `SELECT * FROM wallet_entries WHERE session_id = ? AND ${OWNED('character_id')} ORDER BY entry_date ASC`, s.id, userId);
  const lootEntries = await all(db,
    `SELECT * FROM loot_entries WHERE session_id = ? AND ${OWNED('character_id')} ORDER BY loot_date ASC`, s.id, userId);
  const { wallet, loot } = totalsByCharacter(walletEntries, lootEntries, characters);
  const durationHours = Math.max((parseDb(s.end_time) - parseDb(s.start_time)) / 1000, 0) / 3600;

  return page(session, sessionDetailPage({
    session: s,
    session_label: `Session #${s.id}`,
    character_label: characters.get(Number(s.source_character_id)) ?? s.source_character_id,
    wallet_entries: walletEntries,
    loot_entries: lootEntries,
    characters,
    wallet_by_character: wallet,
    loot_by_character: loot,
    duration_hours: durationHours,
    isk_per_hour: durationHours > 0 ? Number(s.total_value || 0) / durationHours : 0,
    session_chart: buildSessionChart(s, walletEntries, lootEntries),
    timezone_name: session.timezone(),
  }));
}

// ---------- Reports ----------

async function reportContext(req) {
  const { env, session, url, userId } = req;
  const db = env.DB;
  const tz = session.timezone();
  const { start, end, abbrev, rangeValue } = rangeBounds(url, tz, '30');
  const characterId = url.searchParams.get('character_id') || '';
  const activity = url.searchParams.get('activity') || 'All';
  const { rows: characters, map: characterMapping } = await characterMap(db, userId);

  let sql = 'SELECT s.* FROM sessions s JOIN characters c ON s.source_character_id = c.character_id WHERE c.user_id = ?';
  const params = [userId];
  if (start) { sql += ' AND s.start_time >= ?'; params.push(start); }
  if (end) { sql += ' AND s.start_time <= ?'; params.push(end); }
  if (characterId && optInt(characterId) !== null) { sql += ' AND s.source_character_id = ?'; params.push(optInt(characterId)); }
  if (activity && activity !== 'All') { sql += ' AND s.activity_type = ?'; params.push(activity); }
  sql += ' ORDER BY s.start_time DESC';
  const sessions = await all(db, sql, ...params);

  const hoursOf = (s) => Math.max((parseDb(s.end_time) - parseDb(s.start_time)) / 3600000, 0.01);
  let totalWallet = 0;
  let totalLoot = 0;
  let totalValue = 0;
  let totalHours = 0;
  const byActivity = new Map();
  const byCharacter = new Map();
  for (const s of sessions) {
    const wallet = Number(s.wallet_income || 0);
    const loot = Number(s.loot_value || 0);
    const total = Number(s.total_value || 0);
    const hours = hoursOf(s);
    totalWallet += wallet;
    totalLoot += loot;
    totalValue += total;
    totalHours += hours;

    const act = s.activity_type || 'Unclassified';
    if (!byActivity.has(act)) byActivity.set(act, { activity: act, sessions: 0, wallet: 0, loot: 0, total: 0, hours: 0 });
    const a = byActivity.get(act);
    a.sessions += 1; a.wallet += wallet; a.loot += loot; a.total += total; a.hours += hours;

    const name = characterMapping.get(Number(s.source_character_id)) ?? 'Unknown Character';
    if (!byCharacter.has(name)) byCharacter.set(name, { character: name, sessions: 0, wallet: 0, loot: 0, total: 0, hours: 0, Ratting: 0, Incursions: 0, Missions: 0 });
    const c = byCharacter.get(name);
    c.sessions += 1; c.wallet += wallet; c.loot += loot; c.total += total; c.hours += hours;
    if (['Ratting', 'Incursions', 'Missions'].includes(act)) c[act] += wallet;
  }

  const qs = (exportType = null) => {
    const p = { range: rangeValue, character_id: characterId, activity };
    if (rangeValue === 'custom') {
      p.start_date = url.searchParams.get('start_date') || '';
      p.end_date = url.searchParams.get('end_date') || '';
    }
    if (exportType) p.type = exportType;
    return new URLSearchParams(Object.entries(p).filter(([, v]) => v !== null && v !== '')).toString();
  };

  return {
    start, end, tz, characterId, activity,
    characters,
    character_map: characterMapping,
    sessions: sessions.slice(0, 200),
    activity_rows: [...byActivity.values()].sort((a, b) => b.total - a.total),
    character_rows: [...byCharacter.values()].sort((a, b) => b.total - a.total),
    total_wallet: totalWallet,
    total_loot: totalLoot,
    total_value: totalValue,
    total_hours: totalHours,
    isk_hour: totalHours ? totalValue / totalHours : 0,
    selected_range: rangeValue,
    selected_character_id: characterId,
    selected_activity: activity,
    start_date: url.searchParams.get('start_date') || '',
    end_date: url.searchParams.get('end_date') || '',
    timezone_name: tz,
    timezone_abbrev: abbrev,
    qs,
  };
}

export async function reports(req) {
  return page(req.session, reportsPage(await reportContext(req)));
}

export async function reportsExport(req) {
  const { env, url, userId } = req;
  const db = env.DB;
  const ctx = await reportContext(req);
  const type = url.searchParams.get('type') || 'sessions';
  const { start, end, tz, characterId, activity, character_map: names } = ctx;
  const nameOf = (id) => names.get(Number(id)) ?? id;

  if (type === 'activity') {
    return csvResponse('evewallet_activity_report.csv',
      ['Activity', 'Sessions', 'Wallet Income', 'Loot Value', 'Total Value', 'Hours', 'ISK/Hour'],
      ctx.activity_rows.map((r) => [r.activity, r.sessions, pyRound(r.wallet), pyRound(r.loot), pyRound(r.total), pyRound(r.hours, 4), pyRound(r.hours ? r.total / r.hours : 0)]));
  }
  if (type === 'characters') {
    return csvResponse('evewallet_character_report.csv',
      ['Character', 'Sessions', 'Wallet Income', 'Loot Value', 'Total Value', 'Ratting', 'Incursions', 'Missions', 'Hours', 'ISK/Hour'],
      ctx.character_rows.map((r) => [r.character, r.sessions, pyRound(r.wallet), pyRound(r.loot), pyRound(r.total), pyRound(r.Ratting), pyRound(r.Incursions), pyRound(r.Missions), pyRound(r.hours, 4), pyRound(r.hours ? r.total / r.hours : 0)]));
  }

  const filters = (table, dateColumn) => {
    let where = OWNED(`${table}.character_id`);
    const params = [userId];
    if (start) { where += ` AND ${dateColumn} >= ?`; params.push(start); }
    if (end) { where += ` AND ${dateColumn} <= ?`; params.push(end); }
    if (characterId && optInt(characterId) !== null) { where += ` AND ${table}.character_id = ?`; params.push(optInt(characterId)); }
    if (activity && activity !== 'All') { where += ` AND ${table}.activity_type = ?`; params.push(activity); }
    return { where, params };
  };

  if (type === 'raw_wallet') {
    const f = filters('wallet_entries', 'entry_date');
    const rows = await all(db, `SELECT * FROM wallet_entries WHERE ${f.where} ORDER BY entry_date DESC`, ...f.params);
    return csvResponse('evewallet_raw_wallet_entries.csv',
      ['Local Time', 'EVE Time', 'Character', 'Ref Type', 'Description', 'Amount', 'Balance', 'Activity', 'Session', 'ESI ID'],
      rows.map((e) => [formatLocal(e.entry_date, tz), formatUtc(e.entry_date), nameOf(e.character_id), e.ref_type, e.description || '', pyRound(e.amount), pyRound(e.balance), e.activity_type || '', e.session_id || '', e.esi_journal_id]));
  }
  if (type === 'loot') {
    const f = filters('loot_entries', 'loot_date');
    const rows = await all(db, `SELECT * FROM loot_entries WHERE ${f.where} ORDER BY loot_date DESC`, ...f.params);
    return csvResponse('evewallet_loot_entries.csv',
      ['Local Time', 'EVE Time', 'Character', 'Session', 'Activity', 'Item', 'Type ID', 'Quantity', 'Price Source', 'Jita Price', 'Valuation %', 'Calculated Value'],
      rows.map((e) => [formatLocal(e.loot_date, tz), formatUtc(e.loot_date), nameOf(e.character_id), e.session_id || '', e.activity_type || '', e.item_name, e.type_id || '', e.quantity, e.price_source, pyRound(e.jita_price), pyNum(e.valuation_percentage), pyRound(e.calculated_value)]));
  }

  return csvResponse('evewallet_sessions_report.csv',
    ['Session ID', 'Character', 'Activity', 'Start Local', 'End Local', 'Hours', 'Wallet Income', 'Loot Value', 'Total Value', 'ISK/Hour'],
    ctx.sessions.map((s) => {
      const hours = Math.max((parseDb(s.end_time) - parseDb(s.start_time)) / 3600000, 0.01);
      return [s.id, nameOf(s.source_character_id), s.activity_type, formatLocal(s.start_time, tz), formatLocal(s.end_time, tz), pyRound(hours, 4), pyRound(s.wallet_income), pyRound(s.loot_value), pyRound(s.total_value), pyRound((s.total_value || 0) / hours)];
    }));
}
