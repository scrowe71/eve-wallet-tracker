// CSV output matching Python's csv.writer (minimal quoting, \r\n line endings).

import { pyFloat, pyRoundNum } from './html.js';

function cell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvResponse(filename, headers, rows) {
  const lines = [headers, ...rows].map((row) => row.map(cell).join(','));
  return new Response(lines.join('\r\n') + '\r\n', {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

/** Python round(x, n) for display in exports, rendered like a Python float. */
export function pyRound(value, digits = 2) {
  return pyFloat(pyRoundNum(Number(value || 0), digits));
}

/** A stored float column rendered like Python's str(float). */
export const pyNum = (value) => (value === null || value === undefined ? '' : pyFloat(value));
