// Fleet-session grouping and the cumulative ISK/hour chart (ported from routers/sessions.py).

import { parseDb } from './time.js';
import { compactIsk, elapsedLabel } from './html.js';

const FLEET_GROUP_START_TOLERANCE_MS = 20 * 60 * 1000;
const EVENT_GROUP_TOLERANCE_SECONDS = 300; // group multi-character fleet payouts within 5 minutes

const lc = (v) => String(v || '').toLowerCase();

function isRattingBountyEvent(ev) {
  const ref = lc(ev.event);
  const desc = lc(ev.description);
  return ref === 'bounty_prizes' || ref === 'freelance_jobs_reward' || desc.includes('bounty prizes') || desc.includes('freelance jobs');
}

function isRattingEssEvent(ev) {
  return lc(ev.event) === 'ess_escrow_transfer' || lc(ev.description).includes('encounter surveillance system');
}

function eventKind(ev) {
  if (isRattingBountyEvent(ev)) return 'bounty';
  if (isRattingEssEvent(ev)) return 'ess';
  if (lc(ev.event) === 'loot') return 'loot';
  return 'other';
}

/** Group nearby same-kind events (several characters paid in the same cycle) into one chart point. */
function groupNearbyEvents(events) {
  events = [...events].sort((a, b) => a.time - b.time);
  const grouped = [];
  let active = null;
  const flush = () => {
    if (!active) return;
    const count = active.count;
    delete active.count;
    if (count > 1) {
      if (active.kind === 'bounty') active.description = `Fleet bounty cycle (${count} entries)`;
      else if (active.kind === 'ess') active.description = `Fleet ESS payout (${count} entries)`;
      else if (active.kind === 'loot') active.description = `Loot batch (${count} items)`;
      else active.description = `Combined event (${count} entries)`;
    }
    grouped.push(active);
    active = null;
  };
  for (const ev of events) {
    const kind = eventKind(ev);
    if (active === null) {
      active = { ...ev, kind, count: 1 };
      continue;
    }
    const secondsApart = Math.abs(ev.time - active.time) / 1000;
    const tolerance = kind === 'loot' ? 1 : EVENT_GROUP_TOLERANCE_SECONDS;
    if (kind === active.kind && secondsApart <= tolerance) {
      if (ev.time < active.time) active.time = ev.time;
      active.amount += Number(ev.amount || 0);
      active.count += 1;
      if (ev.character_id && ev.character_id !== active.character_id) active.character_id = null;
    } else {
      flush();
      active = { ...ev, kind, count: 1 };
    }
  }
  flush();
  return grouped;
}

const isManualLoot = (entry) => lc(entry.price_source) === 'manual isk';

/** Collapse non-manual loot rows entered at the same second into chart events. */
function groupLootEvents(lootEntries) {
  const grouped = new Map();
  for (const entry of lootEntries) {
    const t = parseDb(entry.loot_date);
    if (t === null || isManualLoot(entry)) continue;
    const key = Math.floor(t / 1000);
    if (!grouped.has(key)) {
      grouped.set(key, { time: t, character_id: null, event: 'Loot', description: 'Loot batch', amount: 0, item_count: 0 });
    }
    const g = grouped.get(key);
    g.amount += Number(entry.calculated_value || 0);
    g.item_count += 1;
  }
  for (const ev of grouped.values()) {
    ev.description = `Loot batch (${ev.item_count} item${ev.item_count !== 1 ? 's' : ''})`;
  }
  return [...grouped.values()];
}

const manualAllocationPoint = (time, minutes, cumulative, raw, manual, rate, seq) => ({
  time,
  character_id: null,
  event: 'Manual Loot Allocation',
  description: 'Manual loot value distributed across the full session',
  amount: 0,
  seq,
  elapsed_minutes: minutes,
  elapsed_label: elapsedLabel(minutes),
  actual_elapsed_minutes: minutes,
  actual_elapsed_label: elapsedLabel(minutes),
  elapsed_basis: 'manual loot distributed across full session',
  cumulative,
  raw_cumulative: raw,
  manual_distributed: manual,
  isk_per_hour: rate,
  rate_label: `${compactIsk(rate)}/hr`,
  amount_label: '0',
  cumulative_label: compactIsk(cumulative),
});

export function buildSessionChart(session, walletEntries, lootEntries) {
  const sessionStart = parseDb(session.start_time);
  const sessionEnd = parseDb(session.end_time);
  let rawEvents = [];
  for (const entry of walletEntries) {
    const t = parseDb(entry.entry_date);
    if (t === null) continue;
    rawEvents.push({ time: t, character_id: entry.character_id, event: entry.ref_type || 'Wallet', description: entry.description || '', amount: Number(entry.amount || 0) });
  }
  rawEvents.push(...groupLootEvents(lootEntries));
  rawEvents = groupNearbyEvents(rawEvents);
  rawEvents.sort((a, b) => a.time - b.time);

  // X-axis position: ratting bounties count 20-minute cycles; ESS rows use the
  // latest bounty cycle plus their payout offset; everything else uses real time.
  // Nothing is placed past the session's end (its last wallet or loot entry), so
  // extra bounty cycles can't add time that didn't happen and the chart's last
  // point equals the session's ISK/hour (total / duration).
  const sessionMinutes = sessionStart !== null && sessionEnd !== null && sessionEnd > sessionStart
    ? (sessionEnd - sessionStart) / 60000 : null;
  const capMinutes = (m) => (sessionMinutes ? Math.min(m, sessionMinutes) : m);
  const timed = [];
  let cycles = 0;
  let latestCycleMinutes = 0;
  let latestCycleActual = 0;
  rawEvents.forEach((ev, seq) => {
    const actualMinutes = Math.max((ev.time - sessionStart) / 1000, 0) / 60;
    let effective;
    let basis;
    if (isRattingBountyEvent(ev)) {
      cycles += 1;
      effective = cycles * 20;
      latestCycleMinutes = effective;
      latestCycleActual = actualMinutes;
      basis = '20-minute ratting bounty cycle';
    } else if (isRattingEssEvent(ev) && latestCycleMinutes > 0) {
      effective = latestCycleMinutes + Math.max(actualMinutes - latestCycleActual, 0);
      basis = 'ESS payout: ratting cycle time plus ESS payout offset';
    } else {
      effective = Math.max(actualMinutes, 1);
      basis = 'actual elapsed session time';
    }
    effective = capMinutes(effective);
    timed.push({
      ...ev, seq,
      elapsed_minutes: effective,
      elapsed_label: elapsedLabel(effective),
      actual_elapsed_minutes: actualMinutes,
      actual_elapsed_label: elapsedLabel(actualMinutes),
      elapsed_basis: basis,
    });
  });
  timed.sort((a, b) => a.elapsed_minutes - b.elapsed_minutes || a.time - b.time || a.seq - b.seq);

  const manualTotal = lootEntries.filter(isManualLoot).reduce((sum, e) => sum + Number(e.calculated_value || 0), 0);
  let maxMinutes = sessionMinutes
    ?? Math.max(timed.length ? Math.max(...timed.map((p) => p.elapsed_minutes)) : 0, 20, 1);

  // Manual ISK loot is spread linearly across the session instead of spiking at entry time.
  let cumulative = 0;
  let points = [];
  for (const ev of timed) {
    cumulative += ev.amount;
    const manual = manualTotal * Math.min(Math.max(ev.elapsed_minutes / maxMinutes, 0), 1);
    const shown = cumulative + manual;
    const rate = shown / Math.max(ev.elapsed_minutes / 60, 1 / 60);
    points.push({
      ...ev,
      cumulative: shown,
      raw_cumulative: cumulative,
      manual_distributed: manual,
      isk_per_hour: rate,
      rate_label: `${compactIsk(rate)}/hr`,
      amount_label: compactIsk(ev.amount),
      cumulative_label: compactIsk(shown),
    });
  }

  if (manualTotal && points.length && points[points.length - 1].elapsed_minutes < maxMinutes) {
    const shown = cumulative + manualTotal;
    const rate = shown / Math.max(maxMinutes / 60, 1 / 60);
    points.push(manualAllocationPoint(sessionEnd, maxMinutes, shown, cumulative, manualTotal, rate, timed.length + 1));
  }

  if (!points.length) {
    if (!manualTotal) return { points: [], svg_points: [], x_ticks: [], y_ticks: [], max_minutes: 1, max_rate: 1 };
    maxMinutes = Math.max((sessionEnd - sessionStart) / 60000, 20, 1);
    const rate = manualTotal / Math.max(maxMinutes / 60, 1 / 60);
    points = [manualAllocationPoint(sessionEnd, maxMinutes, manualTotal, 0, manualTotal, rate, 1)];
  }

  const maxRate = Math.max(Math.max(...points.map((p) => p.isk_per_hour)), 1);
  const minRate = Math.min(Math.min(...points.map((p) => p.isk_per_hour)), 0);

  const width = 1000;
  const height = 420;
  const marginLeft = 88;
  const marginRight = 30;
  const marginTop = 34;
  const marginBottom = 58;
  const plotW = width - marginLeft - marginRight;
  const plotH = height - marginTop - marginBottom;
  const sx = (minutes) => marginLeft + (minutes / maxMinutes) * plotW;
  const rateSpan = maxRate - minRate || 1;
  const sy = (rate) => marginTop + ((maxRate - rate) / rateSpan) * plotH;

  const n = points.length;
  const extremes = new Set();
  if (n >= 3) {
    for (let i = 1; i < n - 1; i++) {
      const prev = points[i - 1].isk_per_hour;
      const cur = points[i].isk_per_hour;
      const next = points[i + 1].isk_per_hour;
      if ((cur >= prev && cur >= next) || (cur <= prev && cur <= next)) extremes.add(i);
    }
  }
  let labels;
  const range = (start, stop, step) => { const out = []; for (let i = start; i < stop; i += step) out.push(i); return out; };
  if (n <= 12) {
    labels = new Set(range(0, n, 1));
  } else {
    labels = new Set(range(0, n, n <= 30 ? 3 : 5));
    for (const i of extremes) labels.add(i);
    labels.add(n - 1);
  }
  if (labels.size > 18) {
    const kept = new Set([0, n - 1]);
    for (const i of range(0, n, Math.max(1, Math.floor(n / 14)))) kept.add(i);
    let hi = 0;
    let lo = 0;
    points.forEach((p, i) => {
      if (p.isk_per_hour > points[hi].isk_per_hour) hi = i;
      if (p.isk_per_hour < points[lo].isk_per_hour) lo = i;
    });
    kept.add(hi);
    kept.add(lo);
    labels = kept;
  }

  const round2 = (v) => Math.round(v * 100) / 100;
  const svgPoints = points.map((p, i) => {
    const x = sx(p.elapsed_minutes);
    const y = sy(p.isk_per_hour);
    const dy = i % 2 === 0 ? -12 : 20;
    return { ...p, x: round2(x), y: round2(y), label_y: round2(Math.max(12, Math.min(height - marginBottom + 18, y + dy))), show_label: labels.has(i) };
  });

  const ticks = 5;
  const xTicks = range(0, ticks + 1, 1).map((i) => {
    const minutes = (maxMinutes * i) / ticks;
    return { x: round2(sx(minutes)), label: elapsedLabel(minutes) };
  });
  const yTicks = range(0, ticks + 1, 1).map((i) => {
    const rate = minRate + (rateSpan * i) / ticks;
    return { y: round2(sy(rate)), label: `${compactIsk(rate)}/hr` };
  });

  return {
    points,
    svg_points: svgPoints,
    line_path: svgPoints.map((p) => `${p.x},${p.y}`).join(' '),
    x_ticks: xTicks,
    y_ticks: yTicks,
    width, height,
    margin_left: marginLeft, margin_right: marginRight, margin_top: marginTop, margin_bottom: marginBottom,
    plot_w: plotW, plot_h: plotH,
    max_minutes: maxMinutes, max_rate: maxRate,
  };
}

function formatCharacterList(sessionRows, characters) {
  const names = [];
  for (const s of sessionRows) {
    const name = characters.get(Number(s.source_character_id)) ?? String(s.source_character_id);
    if (!names.includes(name)) names.push(name);
  }
  if (names.length <= 3) return names.join(', ');
  return `${names.length} chars: ${names.slice(0, 3).join(', ')}, ...`;
}
export { formatCharacterList };

/**
 * Group overlapping per-character sessions with the same activity and nearly the
 * same start into one fleet session, as shown on the Sessions page and Dashboard.
 */
export function buildFleetGroups(rows, characters) {
  const sorted = [...rows].map((s) => ({ ...s, _start: parseDb(s.start_time), _end: parseDb(s.end_time) }))
    .sort((a, b) => {
      const aa = a.activity_type || '';
      const bb = b.activity_type || '';
      if (aa !== bb) return aa < bb ? -1 : 1;
      return a._start - b._start;
    });
  const groups = [];
  for (const s of sorted) {
    let placed = false;
    for (const g of groups) {
      if (g.activity_type !== s.activity_type) continue;
      const startClose = Math.abs(s._start - g.anchor) <= FLEET_GROUP_START_TOLERANCE_MS;
      const overlaps = Math.min(s._end, g.end) >= Math.max(s._start, g.start);
      if (startClose && overlaps) {
        g.sessions.push(s);
        g.ids.push(s.id);
        g.start = Math.min(g.start, s._start);
        g.end = Math.max(g.end, s._end);
        g.wallet_income += Number(s.wallet_income || 0);
        g.loot_value += Number(s.loot_value || 0);
        g.total_value += Number(s.total_value || 0);
        placed = true;
        break;
      }
    }
    if (!placed) {
      groups.push({
        anchor: s._start, start: s._start, end: s._end, activity_type: s.activity_type,
        sessions: [s], ids: [s.id],
        wallet_income: Number(s.wallet_income || 0), loot_value: Number(s.loot_value || 0), total_value: Number(s.total_value || 0),
      });
    }
  }
  const result = groups.map((g) => {
    const seconds = Math.max((g.end - g.start) / 1000, 0);
    const ids = [...g.ids].sort((a, b) => a - b).join(',');
    return {
      group_id: ids,
      start_ms: g.start,
      end_ms: g.end,
      activity_type: g.activity_type,
      wallet_income: g.wallet_income,
      loot_value: g.loot_value,
      total_value: g.total_value,
      isk_per_hour: seconds > 0 ? (g.total_value * 3600) / seconds : 0,
      character_count: g.ids.length,
      character_label: formatCharacterList(g.sessions, characters),
      details_url: `/sessions/fleet?ids=${ids}`,
    };
  });
  result.sort((a, b) => b.start_ms - a.start_ms);
  return result;
}
