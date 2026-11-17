// Date/time helpers.
//
// The database stores every timestamp as naive UTC text in the same format the
// original Python app used ("YYYY-MM-DD HH:MM:SS.ffffff"), so the data imported
// from the old SQLite file compares and sorts correctly alongside new rows.

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** Parse a stored timestamp (naive UTC) into epoch milliseconds, or null. */
export function parseDb(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value;
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/);
  if (!m) {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  const ms = m[7] ? Number((m[7] + '000').slice(0, 3)) : 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms);
}

/** Format epoch milliseconds as a stored timestamp. */
export function toDb(ms) {
  if (ms === null || ms === undefined) return null;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}000`;
}

export const nowDb = () => toDb(Date.now());

const dtfCache = new Map();
function dtf(tz) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      timeZoneName: 'short',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

/** Return a valid IANA timezone name, falling back to UTC. */
export function safeTz(tz) {
  if (!tz) return 'UTC';
  try {
    dtf(tz);
    return tz;
  } catch {
    return 'UTC';
  }
}

// en-US only knows US abbreviations (EST, PDT); other zones come out as "GMT+1".
// Other English locales know their own (BST, AEST, IST...), like Python's %Z.
const ABBREV_LOCALES = ['en-GB', 'en-AU', 'en-NZ', 'en-IN', 'en-IE', 'en-ZA', 'en-CA', 'en-SG'];
const abbrevCache = new Map();
function zoneAbbrev(ms, tz, usName) {
  if (!usName.startsWith('GMT') || tz === 'UTC' || tz === 'Etc/UTC') return usName;
  const key = `${tz}|${usName}`;
  if (abbrevCache.has(key)) return abbrevCache.get(key);
  let found = usName;
  for (const locale of ABBREV_LOCALES) {
    const name = new Intl.DateTimeFormat(locale, { timeZone: tz, timeZoneName: 'short' })
      .formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName')?.value;
    if (name && !name.startsWith('GMT') && !name.startsWith('UTC') && /^[A-Z]{2,5}$/.test(name)) {
      found = name;
      break;
    }
  }
  abbrevCache.set(key, found);
  return found;
}

/** Local wall-clock parts for an instant in a timezone. */
export function localParts(ms, tz) {
  const parts = {};
  for (const p of dtf(safeTz(tz)).formatToParts(new Date(ms))) parts[p.type] = p.value;
  return {
    year: +parts.year, month: +parts.month, day: +parts.day,
    hour: +parts.hour % 24, minute: +parts.minute, second: +parts.second,
    tzName: zoneAbbrev(ms, tz, parts.timeZoneName),
  };
}

/** Offset of the timezone from UTC at an instant, in milliseconds. */
export function tzOffsetMs(ms, tz) {
  const p = localParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Convert a local wall-clock time in a timezone to epoch milliseconds. */
export function localToUtcMs(year, month, day, hour, minute, second, tz) {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = wall - tzOffsetMs(wall, tz);
  guess = wall - tzOffsetMs(guess, tz);
  return guess;
}

/** Same as Python's strftime("%Y-%m-%d %I:%M:%S %p %Z") in the user's timezone. */
export function formatLocal(value, tz, includeTz = true) {
  const ms = parseDb(value);
  if (ms === null) return '';
  const p = localParts(ms, safeTz(tz));
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  const ampm = p.hour < 12 ? 'AM' : 'PM';
  const zone = safeTz(tz) === 'UTC' ? 'UTC' : p.tzName;
  const text = `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(h12)}:${pad(p.minute)}:${pad(p.second)} ${ampm}`;
  return includeTz ? `${text} ${zone}` : text;
}

/** "%Y-%m-%d %H:%M:%S UTC" */
export function formatUtc(value) {
  const ms = parseDb(value);
  if (ms === null) return '';
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}

function parseYmd(text) {
  const m = String(text || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return [y, mo, d];
}

/** Local calendar dates (YYYY-MM-DD) to UTC bounds: [start of start day, start of day after end day). */
export function localDateBoundsToUtc(startDate, endDate, tz) {
  tz = safeTz(tz);
  let start = null;
  let end = null;
  const s = parseYmd(startDate);
  if (s) start = toDb(localToUtcMs(s[0], s[1], s[2], 0, 0, 0, tz));
  const e = parseYmd(endDate);
  if (e) {
    const next = new Date(Date.UTC(e[0], e[1] - 1, e[2] + 1));
    end = toDb(localToUtcMs(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, 0, tz));
  }
  return [start, end];
}

/** Dashboard/report date ranges: today, yesterday, 7, 30. Returns [startDb, endDb, tzAbbrev]. */
export function dashboardRangeBoundsUtc(rangeValue, tz) {
  tz = safeTz(tz);
  const now = Date.now();
  const p = localParts(now, tz);
  const todayStart = localToUtcMs(p.year, p.month, p.day, 0, 0, 0, tz);
  let start;
  let end;
  if (rangeValue === 'yesterday') {
    const y = new Date(Date.UTC(p.year, p.month - 1, p.day - 1));
    start = localToUtcMs(y.getUTCFullYear(), y.getUTCMonth() + 1, y.getUTCDate(), 0, 0, 0, tz);
    end = todayStart;
  } else if (rangeValue === '7') {
    start = now - 7 * 86400000;
    end = now;
  } else if (rangeValue === '30') {
    start = now - 30 * 86400000;
    end = now;
  } else {
    start = todayStart;
    end = now;
  }
  return [toDb(start), toDb(end), tz === 'UTC' ? 'UTC' : p.tzName];
}
