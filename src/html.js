// HTML helpers used by the page templates in src/views.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&#34;', "'": '&#39;' };

/** Escape a value for HTML text or attribute context. null/undefined render as ''. */
export function h(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** Mark a string as already-safe HTML (used by the html`` tag). */
export class Raw {
  constructor(text) { this.text = text; }
  toString() { return this.text; }
}
export const raw = (text) => new Raw(text);

function render(value) {
  if (value instanceof Raw) return value.text;
  if (Array.isArray(value)) return value.map(render).join('');
  if (value === null || value === undefined || value === false) return '';
  return h(value);
}

/** Template tag: interpolated values are escaped unless they are Raw or arrays of Raw. */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new Raw(out);
}

/**
 * Format a number with `digits` decimals exactly the way Python does
 * (f"{x:.2f}", round()): exact binary value, ties rounded to even.
 * JavaScript's toFixed/Intl round ties up, which shifts some totals by 1 ISK.
 */
export function pyFixed(value, digits = 0) {
  let x = Number(value);
  if (!Number.isFinite(x)) x = 0;
  const negative = x < 0 || Object.is(x, -0);
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(x));
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);
  const expBits = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let exp;
  if (expBits === 0) exp = -1074;
  else { mant |= 1n << 52n; exp = expBits - 1075; }
  const scale = 10n ** BigInt(digits);
  let q;
  if (exp >= 0) {
    q = (mant << BigInt(exp)) * scale;
  } else {
    const num = mant * scale;
    const den = 1n << BigInt(-exp);
    q = num / den;
    const twice = (num % den) * 2n;
    if (twice > den || (twice === den && q % 2n === 1n)) q += 1n;
  }
  let text = q.toString().padStart(digits + 1, '0');
  if (digits > 0) text = `${text.slice(0, -digits)}.${text.slice(-digits)}`;
  return negative ? `-${text}` : text; // Python also prints -0 for small negatives
}

const commas = (fixedText) => {
  const [int, frac] = fixedText.split('.');
  const sign = int.startsWith('-') ? '-' : '';
  const digits = sign ? int.slice(1) : int;
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac !== undefined ? `.${frac}` : '');
};

/** Same as the old Jinja "isk" filter: "1,234,567 ISK". */
export function isk(value) {
  const n = Number(value);
  if (value === null || value === undefined || Number.isNaN(n)) return '0 ISK';
  return `${commas(pyFixed(n, 0))} ISK`;
}

/** "{:,.2f}" */
export const comma2 = (value) => commas(pyFixed(Number(value || 0), 2));

/** "%.2f" */
export const fixed2 = (value) => pyFixed(Number(value || 0), 2);

/** Python round(x, digits) as a number. */
export const pyRoundNum = (value, digits = 0) => Number(pyFixed(value, digits));

/** Python-style str() for numbers stored as floats (95.0 -> "95.0"). */
export function pyFloat(value) {
  const n = Number(value);
  if (Number.isNaN(n)) return String(value ?? '');
  return Number.isInteger(n) ? `${n}.0` : String(n);
}

/** "125M", "1.2B" etc. */
export function compactIsk(value) {
  let v = Number(value || 0);
  if (Number.isNaN(v)) v = 0;
  const sign = v < 0 ? '-' : '';
  v = Math.abs(v);
  let text;
  if (v >= 1e9) text = `${pyFixed(v / 1e9, 1)}B`;
  else if (v >= 1e6) text = `${pyFixed(v / 1e6, 0)}M`;
  else if (v >= 1e3) text = `${pyFixed(v / 1e3, 0)}K`;
  else text = pyFixed(v, 0);
  return `${sign}${text}`;
}

/** "1h 20m" */
export function elapsedLabel(minutes) {
  minutes = Math.max(Number(minutes || 0), 0);
  const hh = Math.floor(minutes / 60);
  const mm = pyRoundNum(minutes % 60, 0);
  if (hh && mm) return `${hh}h ${mm}m`;
  if (hh) return `${hh}h`;
  return `${mm}m`;
}
