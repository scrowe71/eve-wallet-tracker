// Response helpers shared by the route handlers.

import { layout } from './views/layout.js';

export const redirect = (location, status = 303) => new Response(null, { status, headers: { Location: location } });

export const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

export const text = (body, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

/** FastAPI-style error body: {"detail": "..."} */
export const httpError = (status, detail) => json({ detail }, status);

export function page(session, content, status = 200, title = null) {
  return new Response(String(layout(session, content, title)), {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

/** Parse an optional integer query/form value ('' and junk -> null). */
export function optInt(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const n = Number(String(value).trim());
  return Number.isInteger(n) ? n : null;
}

/** Python float() on form input; throws on junk like Python does. */
export function pyFloatParse(value) {
  const t = String(value ?? '').trim();
  const n = t === '' ? NaN : Number(t);
  if (Number.isNaN(n)) throw new Error(`could not convert string to float: '${t}'`);
  return n;
}

/** Python int() on form input; throws on junk. */
export function pyIntParse(value) {
  const t = String(value ?? '').trim();
  if (!/^[+-]?\d+$/.test(t)) throw new Error(`invalid literal for int() with base 10: '${t}'`);
  return parseInt(t, 10);
}
