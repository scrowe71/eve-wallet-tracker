// Page templates (ported from app/templates/*.html).

import { html, isk, comma2, fixed2, pyFloat } from '../html.js';
import { formatLocal, formatUtc } from '../time.js';

const sel = (cond) => (cond ? ' selected' : '');
const opt = (value, label, selected) => html`<option value="${value}"${sel(selected)}>${label}</option>`;

const RANGE_OPTIONS = [['today', 'Today'], ['yesterday', 'Yesterday'], ['7', 'Previous 7 Days'], ['30', 'Previous 30 Days'], ['custom', 'Custom Range']];

// ---------- About ----------

export const aboutPage = () => html`
<div class="card">
  <h2>About EVE Wallet Tracker</h2>
  <p class="muted">Stable v1</p>
  <p>EVE Wallet Tracker is a web-based EVE Online income tracker focused on ESI wallet data, session analysis, loot valuation, and reporting.</p>
</div>

<div class="card">
  <h3>Stable v1 Highlights</h3>
  <ul>
    <li>EVE SSO login</li>
    <li>Wallet sync</li>
    <li>User isolation</li>
    <li>Dashboard</li>
    <li>Raw data</li>
    <li>Sessions</li>
    <li>Loot valuation</li>
    <li>Reports/export</li>
  </ul>
</div>

<div class="card">
  <h3>Supported Activities</h3>
  <ul>
    <li>Ratting</li>
    <li>Incursions</li>
    <li>Missions</li>
    <li>Loot tracking</li>
  </ul>
</div>`;

// ---------- Characters ----------

export const charactersPage = ({ characters, linked, tz }) => html`
<div class="card">
  <h2>Characters</h2>
  ${linked ? html`<div class="card success">Character linked successfully.</div>` : ''}
  <p><a class="button" href="/auth/add-character">Add ESI-Linked Character</a></p>
</div>
<div class="card">
  <table>
    <tr><th>Character</th><th>Character ID</th><th>Token Expires Local</th><th>Last Wallet Sync Local</th></tr>
    ${characters.length ? characters.map((c) => html`
      <tr>
        <td>${c.character_name}</td>
        <td>${c.character_id}</td>
        <td>${c.token_expires_at ? formatLocal(c.token_expires_at, tz) : 'Unknown'}</td>
        <td>${c.last_wallet_sync_at ? formatLocal(c.last_wallet_sync_at, tz) : 'Never'}</td>
      </tr>`) : html`
      <tr><td colspan="4">No characters linked yet.</td></tr>`}
  </table>
</div>`;

// ---------- Dashboard ----------

export const dashboardPage = (c) => html`
<div class="card">
  <h2>Dashboard</h2>
  <p class="muted">Date ranges are evaluated in your browser timezone: ${c.timezone_name}.</p>
  <form method="get" class="filters">
    <div>
      <label>Date Range</label>
      <select name="range">
        ${RANGE_OPTIONS.map(([v, l]) => opt(v, l, c.selected_range === v))}
      </select>
    </div>
    <div>
      <label>Start Date</label>
      <input type="date" name="start_date" value="${c.start_date}">
    </div>
    <div>
      <label>End Date</label>
      <input type="date" name="end_date" value="${c.end_date}">
    </div>
    <div><label>&nbsp;</label><button>Apply</button></div>
  </form>
</div>

<div class="grid">
  <div class="card"><div class="muted">Wallet Income</div><div class="metric">${isk(c.wallet)}</div></div>
  <div class="card"><div class="muted">Loot Value</div><div class="metric">${isk(c.loot)}</div></div>
  <div class="card"><div class="muted">Total Value</div><div class="metric">${isk(c.total)}</div></div>
  <div class="card"><div class="muted">ISK / Hour</div><div class="metric">${isk(c.isk_hour)}</div></div>
  <div class="card"><div class="muted">Sessions</div><div class="metric">${c.session_count}</div></div>
</div>

<div class="card">
  <h3>Income by Activity</h3>
  <table>
    <tr><th>Activity</th><th>Total</th></tr>
    ${[...c.by_activity].map(([k, v]) => html`
      <tr><td>${k}</td><td>${isk(v)}</td></tr>`)}
  </table>
</div>

<div class="card">
  <h3>Character Contribution</h3>
  <p class="muted">Characters with income in the selected date range, sorted by total contribution.</p>
  <table>
    <tr><th>Character</th><th>Total</th><th>Ratting</th><th>Incursions</th><th>Missions</th><th>Loot Value</th></tr>
    ${c.character_contributions.length ? c.character_contributions.map((row) => html`
        <tr>
          <td>${row.character}</td>
          <td>${isk(row.total)}</td>
          <td>${isk(row.Ratting)}</td>
          <td>${isk(row.Incursions)}</td>
          <td>${isk(row.Missions)}</td>
          <td>${isk(row['Loot Value'])}</td>
        </tr>`) : html`
      <tr><td colspan="6" class="muted">No character income found for this date range.</td></tr>`}
  </table>
</div>`;

// ---------- Wallet Sync ----------

export const syncPage = ({ rows, any_ready, results, tz }) => html`
<div class="card">
  <h2>Wallet Sync</h2>
  <form method="post" action="/sync" style="display:inline-block; margin-right: 1rem;">
    <button${any_ready ? '' : ' disabled'}>Sync All Characters</button>
  </form>
  <form method="post" action="/sync/rebuild-sessions" style="display:inline-block;">
    <button>Rebuild Sessions Only</button>
  </form>
  <p class="muted">Rebuild Sessions Only reclassifies existing wallet rows and rebuilds sessions using your browser timezone without contacting ESI.</p>
</div>
${results ? html`
<div class="card">
  <h3>Last Result</h3>
  ${results.message ? html`<p>${results.message}</p>` : ''}
  <p>Sessions created: ${results.sessions_created}</p>
  ${results.characters && results.characters.length ? html`
  <table><tr><th>Character</th><th>Status</th><th>Inserted</th><th>Reason</th></tr>${results.characters.map((r) => html`<tr><td>${r.character}</td><td>${r.status}</td><td>${r.inserted}</td><td>${r.reason || ''}</td></tr>`)}</table>` : ''}
</div>` : ''}
<div class="card">
  <table>
    <tr><th>Character</th><th>Last Sync Local</th><th>Last Sync EVE</th><th>Next Available</th><th>Status</th></tr>
    ${rows.length ? rows.map((row) => html`
      <tr>
        <td>${row.character.character_name}</td>
        <td>${row.character.last_wallet_sync_at ? formatLocal(row.character.last_wallet_sync_at, tz) : 'Never'}</td>
        <td>${row.character.last_wallet_sync_at ? formatUtc(row.character.last_wallet_sync_at) : 'Never'}</td>
        <td>${row.next_available}</td>
        <td>${row.status}</td>
      </tr>`) : html`
      <tr><td colspan="5">No linked characters.</td></tr>`}
  </table>
</div>`;

// ---------- Raw Data ----------

export function rawDataPage(c) {
  const p = c.params;
  const qs = (extra = {}) => new URLSearchParams({
    ...extra,
    character_id: p.character_id, ref_type: p.ref_type, activity_type: p.activity_type,
    amount_filter: p.amount_filter, start_date: p.start_date, end_date: p.end_date, search: p.search,
  }).toString();
  return html`
<div class="card">
  <h2>Raw Wallet Data</h2>
    <p class="muted">Review wallet journal entries imported from ESI. Dates are filtered and displayed in your browser timezone: ${c.timezone_name}. EVE Time (UTC) is also shown for verification.</p>
    <form method="get" class="filters">
      <label>Character</label>
      <select name="character_id">
        <option value="">All characters</option>
        ${c.characters.map((ch) => opt(ch.character_id, ch.character_name, String(p.character_id) === String(ch.character_id)))}
      </select>

      <label>Ref Type</label>
      <select name="ref_type">
        <option value="">All ref types</option>
        ${c.ref_types.map((r) => opt(r, r, p.ref_type === r))}
      </select>

      <label>Activity</label>
      <select name="activity_type">
        <option value="">All activities</option>
        ${c.activity_types.map((a) => opt(a, a, p.activity_type === a))}
        ${opt('Uncategorized', 'Uncategorized', p.activity_type === 'Uncategorized')}
      </select>

      <label>Amount</label>
      <select name="amount_filter">
        ${opt('all', 'All', p.amount_filter === 'all')}
        ${opt('positive', 'Positive only', p.amount_filter === 'positive')}
        ${opt('negative', 'Negative only', p.amount_filter === 'negative')}
        ${opt('zero', 'Zero only', p.amount_filter === 'zero')}
      </select>

      <label>Start date</label>
      <input type="date" name="start_date" value="${p.start_date}">

      <label>End date</label>
      <input type="date" name="end_date" value="${p.end_date}">

      <label>Search</label>
      <input type="text" name="search" value="${p.search}" placeholder="Description or ref type">

      <button type="submit">Apply Filters</button>
      <a class="button" href="/raw-data">Reset</a>
      <a class="button" href="/raw-data/export?${qs()}">Export CSV</a>
    </form>
</div>

<div class="card">
  <h3>Wallet Journal Entries</h3>
  <p class="muted">Showing up to ${c.per_page} rows per page. Total matching rows: ${c.total_rows}.</p>
  <table>
    <tr>
      <th>Local Time</th>
      <th>EVE Time</th>
      <th>Character</th>
      <th>Ref Type</th>
      <th>Description</th>
      <th>Amount</th>
      <th>Balance</th>
      <th>Activity</th>
      <th>Session</th>
      <th>ESI ID</th>
    </tr>
    ${c.rows.length ? c.rows.map((e) => html`
      <tr>
        <td>${formatLocal(e.entry_date, c.timezone_name)}</td>
        <td>${formatUtc(e.entry_date)}</td>
        <td>${e.character_name}</td>
        <td>${e.ref_type}</td>
        <td>${e.description || ''}</td>
        <td class="number">${comma2(e.amount)}</td>
        <td class="number">${e.balance !== null && e.balance !== undefined ? comma2(e.balance) : ''}</td>
        <td>${e.activity_type || ''}</td>
        <td>${e.session_id || ''}</td>
        <td>${e.esi_journal_id}</td>
      </tr>`) : html`
      <tr><td colspan="10">No wallet entries match the selected filters.</td></tr>`}
  </table>

  <div class="pagination">
    ${c.page > 1 ? html`<a class="button" href="/raw-data?${qs({ page: c.page - 1 })}">Previous</a>` : ''}
    <span class="muted">Page ${c.page} of ${c.total_pages}</span>
    ${c.page < c.total_pages ? html`<a class="button" href="/raw-data?${qs({ page: c.page + 1 })}">Next</a>` : ''}
  </div>
</div>`;
}

// ---------- Sessions ----------

export const sessionsPage = ({ session_groups, tz }) => html`
<div class="card">
  <h2>Sessions</h2>
  <form method="post" action="/sessions/rebuild"><button>Rebuild Sessions</button></form>
  <p class="muted">Uses existing wallet data only. No ESI sync is performed. Similar overlapping character sessions are grouped into combined fleet sessions. Session dates display in your browser timezone: ${tz}.</p>
</div>
<div class="card">
  <table>
    <tr><th>Start Local</th><th>Start EVE</th><th>Elapsed</th><th>Characters</th><th>Activity</th><th>Wallet</th><th>Loot</th><th>Total</th><th>ISK / Hour</th><th>Details</th></tr>
    ${session_groups.length ? session_groups.map((s) => {
      const seconds = Math.trunc((s.end_ms - s.start_ms) / 1000);
      return html`
      <tr>
        <td>${formatLocal(s.start_ms, tz)}</td>
        <td>${formatUtc(s.start_ms)}</td>
        <td>${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m</td>
        <td>${s.character_label}</td>
        <td>${s.activity_type}</td>
        <td>${isk(s.wallet_income)}</td>
        <td>${isk(s.loot_value)}</td>
        <td>${isk(s.total_value)}</td>
        <td>${isk(s.isk_per_hour)}</td>
        <td><a class="button" href="${s.details_url}">Details</a></td>
      </tr>`;
    }) : html`
      <tr><td colspan="10">No sessions yet.</td></tr>`}
  </table>
</div>`;

// ---------- Session detail ----------

function chartSvg(ch) {
  return html`
  <svg viewBox="0 0 ${ch.width} ${ch.height}" width="100%" height="420" role="img" aria-label="Cumulative ISK per hour chart" style="background:#0b1220;border:1px solid #2a3a51;border-radius:10px;">
    <rect x="0" y="0" width="${ch.width}" height="${ch.height}" fill="#0b1220"></rect>
    ${ch.y_ticks.map((t) => html`
      <line x1="${ch.margin_left}" y1="${t.y}" x2="${ch.width - ch.margin_right}" y2="${t.y}" stroke="#263548" stroke-width="1"></line>
      <text x="${ch.margin_left - 10}" y="${t.y + 4}" text-anchor="end" fill="#cbd5e1" font-size="13">${t.label}</text>`)}
    ${ch.x_ticks.map((t) => html`
      <line x1="${t.x}" y1="${ch.margin_top}" x2="${t.x}" y2="${ch.height - ch.margin_bottom}" stroke="#1f2d3f" stroke-width="1"></line>
      <text x="${t.x}" y="${ch.height - 24}" text-anchor="middle" fill="#cbd5e1" font-size="13">${t.label}</text>`)}

    <line x1="${ch.margin_left}" y1="${ch.height - ch.margin_bottom}" x2="${ch.width - ch.margin_right}" y2="${ch.height - ch.margin_bottom}" stroke="#94a3b8" stroke-width="1.5"></line>
    <line x1="${ch.margin_left}" y1="${ch.margin_top}" x2="${ch.margin_left}" y2="${ch.height - ch.margin_bottom}" stroke="#94a3b8" stroke-width="1.5"></line>

    <text x="${ch.margin_left + ch.plot_w / 2}" y="${ch.height - 6}" text-anchor="middle" fill="#e7eef8" font-size="14">Effective session earning time</text>
    <text x="18" y="${ch.margin_top + ch.plot_h / 2}" text-anchor="middle" fill="#e7eef8" font-size="14" transform="rotate(-90 18 ${ch.margin_top + ch.plot_h / 2})">Cumulative ISK / hour</text>

    <polyline points="${ch.line_path}" fill="none" stroke="#38bdf8" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></polyline>

    ${ch.svg_points.map((p) => html`
      <circle cx="${p.x}" cy="${p.y}" r="4.5" fill="#facc15" stroke="#0b1220" stroke-width="1.5">
        <title>${p.elapsed_label} | ${p.rate_label} | Event: ${p.event} | Amount: ${p.amount_label} ISK | Cumulative: ${p.cumulative_label} ISK | Basis: ${p.elapsed_basis}</title>
      </circle>
      ${p.show_label ? html`<text x="${p.x}" y="${p.label_y}" text-anchor="middle" fill="#f8fafc" font-size="12" font-weight="bold" paint-order="stroke" stroke="#0b1220" stroke-width="4">${p.rate_label}</text>` : ''}`)}
  </svg>`;
}

export function sessionDetailPage(c) {
  const s = c.session;
  const tz = c.timezone_name;
  const names = [...new Set([...c.wallet_by_character.keys(), ...c.loot_by_character.keys()])].sort();
  const charName = (id, fallback) => c.characters.get(Number(id)) ?? fallback;
  return html`
<div class="card">
  <p><a href="/sessions">← Back to Sessions</a></p>
  <h2>${c.session_label || `Session #${s.id}`}</h2>
  <table>
    <tr><th>Activity</th><td>${s.activity_type}</td></tr>
    <tr><th>Character(s)</th><td>${c.character_label || charName(s.source_character_id, s.source_character_id)}</td></tr>
    <tr><th>Start Local</th><td>${formatLocal(s.start_time, tz)}</td></tr>
    <tr><th>End Local</th><td>${formatLocal(s.end_time, tz)}</td></tr>
    <tr><th>Start EVE</th><td>${formatUtc(s.start_time)}</td></tr>
    <tr><th>End EVE</th><td>${formatUtc(s.end_time)}</td></tr>
    <tr><th>Duration</th><td>${fixed2(c.duration_hours)} hours</td></tr>
    <tr><th>Net Wallet Income</th><td>${isk(s.wallet_income)}</td></tr>
    <tr><th>Loot Value</th><td>${isk(s.loot_value)}</td></tr>
    <tr><th>Total Value</th><td>${isk(s.total_value)}</td></tr>
    <tr><th>ISK / Hour</th><td>${isk(c.isk_per_hour)}</td></tr>
  </table>
</div>

<div class="card">
  <h3>Cumulative ISK / Hour</h3>
  <p class="muted">Line chart shows cumulative ISK/hour at each wallet or loot data point. X-axis is effective session earning time. Ratting bounty cycles use 20-minute intervals; ESS payouts are plotted as their own points using ratting cycle time plus the payout offset after the latest bounty cycle.</p>
  ${c.session_chart.svg_points.length ? html`${chartSvg(c.session_chart)}
  <p class="muted">Labels are intentionally limited to prevent clutter. Hover over any point for event details. Ratting bounty points are normalized to 20-minute cycles; ESS payouts include the actual offset after the latest bounty row so they remain separate chart points.</p>` : html`
    <p>No chart data is available for this session.</p>`}
</div>


<div class="card">
  <h3>Character Totals</h3>
  <table>
    <tr><th>Character</th><th>Net Wallet</th><th>Loot</th><th>Total</th></tr>
    ${names.length ? names.map((name) => html`
      <tr>
        <td>${name}</td>
        <td class="number">${isk(c.wallet_by_character.get(name) || 0)}</td>
        <td class="number">${isk(c.loot_by_character.get(name) || 0)}</td>
        <td class="number">${isk((c.wallet_by_character.get(name) || 0) + (c.loot_by_character.get(name) || 0))}</td>
      </tr>`) : html`
      <tr><td colspan="4">No entries for this session.</td></tr>`}
  </table>
</div>

<div class="card">
  <h3>Wallet Entries</h3>
  <table>
    <tr><th>Local Time</th><th>EVE Time</th><th>Character</th><th>Ref Type</th><th>Description</th><th>Amount</th><th>Balance</th></tr>
    ${c.wallet_entries.length ? c.wallet_entries.map((e) => html`
      <tr>
        <td>${formatLocal(e.entry_date, tz)}</td>
        <td>${formatUtc(e.entry_date)}</td>
        <td>${charName(e.character_id, e.character_id)}</td>
        <td>${e.ref_type}</td>
        <td>${e.description || ''}</td>
        <td class="number">${isk(e.amount)}</td>
        <td class="number">${e.balance !== null && e.balance !== undefined ? isk(e.balance) : ''}</td>
      </tr>`) : html`
      <tr><td colspan="7">No wallet entries for this session.</td></tr>`}
  </table>
</div>

<div class="card">
  <h3>Loot Entries</h3>
  <table>
    <tr><th>Local Time</th><th>EVE Time</th><th>Character</th><th>Item</th><th>Qty</th><th>Source</th><th>Jita Price</th><th>%</th><th>Value</th></tr>
    ${c.loot_entries.length ? c.loot_entries.map((e) => html`
      <tr>
        <td>${e.loot_date ? formatLocal(e.loot_date, tz) : ''}</td>
        <td>${e.loot_date ? formatUtc(e.loot_date) : ''}</td>
        <td>${charName(e.character_id, e.character_id ?? '')}</td>
        <td>${e.item_name}</td>
        <td class="number">${e.quantity}</td>
        <td>${e.price_source}</td>
        <td class="number">${isk(e.jita_price)}</td>
        <td class="number">${pyFloat(e.valuation_percentage)}</td>
        <td class="number">${isk(e.calculated_value)}</td>
      </tr>`) : html`
      <tr><td colspan="9">No loot entries for this session.</td></tr>`}
  </table>
</div>`;
}

// ---------- Loot ----------

export function lootPage(c) {
  const fv = c.form_values || {};
  const pctValue = fv.valuation_percentage !== undefined && fv.valuation_percentage !== null && fv.valuation_percentage !== 0
    ? pyFloat(fv.valuation_percentage) : c.default_pct;
  const preview = c.preview_items || [];
  return html`
<div class="card">
  <h2>Loot</h2>
  <p class="muted">Paste one item per line. Use the format <strong>Item Name &lt;TAB&gt; Quantity</strong>. If quantity is omitted, quantity defaults to 1. Loot is timestamped automatically when confirmed and attached through the shared current-session resolver used by every loot import path.</p>
  <form method="post" action="/loot/preview">
    <div class="filters">
      <div>
        <label>Character</label>
        <select name="character_id">
          ${c.characters.map((ch) => opt(ch.character_id, ch.character_name, Number(fv.character_id) === Number(ch.character_id)))}
        </select>
      </div>
      <div>
        <label>Price Source</label>
        <select name="price_source">
          ${c.price_sources.map((src) => opt(src, src, (fv.price_source || c.default_source) === src))}
        </select>
      </div>
      <div>
        <label>Valuation Percentage</label>
        <input name="valuation_percentage" type="number" step="0.01" min="0" value="${pctValue}">
      </div>
    </div>
    <label>Paste Loot Items</label>
    <textarea name="loot_text" rows="9" style="width:100%;" placeholder="Agency 'Pyrolancea' DB5 Dose II&#9;1&#10;Synth Frentix Booster&#9;1&#10;Synth Mindflood Booster&#9;4&#10;Imperial Navy 1600mm Steel Plates&#9;1">${fv.loot_text || ''}</textarea>
    <p><button type="submit">Parse Loot</button></p>
  </form>
</div>

<div class="card">
  <h3>Add Manual Loot Value</h3>
  <p class="muted">Use this when you already know the ISK value and do not need item lookup or Jita pricing. The entry is timestamped when added and matched to the current/latest session by character and time.</p>
  <form method="post" action="/loot/manual">
    <div class="filters">
      <div>
        <label>Character</label>
        <select name="manual_character_id">
          ${c.characters.map((ch) => opt(ch.character_id, ch.character_name, Number(fv.manual_character_id) === Number(ch.character_id)))}
        </select>
      </div>
      <div>
        <label>Description</label>
        <input name="manual_description" type="text" value="${fv.manual_description || 'Manual Loot Value'}" placeholder="Manual Loot Value">
      </div>
      <div>
        <label>ISK Amount</label>
        <input name="manual_isk_amount" type="text" value="${fv.manual_isk_amount || ''}" placeholder="125,000,000 or 125m">
      </div>
    </div>
    <p><button type="submit" onclick="return confirm('Add this manual ISK amount as loot value?')">Add Manual Loot Value</button></p>
  </form>
</div>

${c.parse_errors && c.parse_errors.length ? html`
<div class="card danger">
  <h3>Parse Errors</h3>
  <ul>
    ${c.parse_errors.map((err) => html`<li>${err}</li>`)}
  </ul>
</div>` : ''}

${preview.length ? html`
<div class="card highlight">
  <h3>${c.calculated ? 'Confirm Bulk Loot Entry' : 'Review Parsed Loot'}</h3>
  <p class="muted">The app prices items using the selected source. Janice Buy uses Janice Jita immediate buy pricing; the saved percentage modifier is then applied. Review the calculated values before confirming the database insert.</p>

  <form method="post" action="${c.calculated ? '/loot' : '/loot/calculate'}">
    <input type="hidden" name="character_id" value="${preview[0].character_id}">
    <input type="hidden" name="price_source" value="${preview[0].price_source}">
    <input type="hidden" name="valuation_percentage" value="${pyFloat(preview[0].valuation_percentage)}">
    <table>
      <tr><th>Character</th><th>Item</th><th>Type ID</th><th>Qty</th><th>Price Source</th><th>ESI Jita Price</th><th>Price Location</th><th>%</th><th>Calculated Value</th></tr>
      ${preview.map((row) => html`
      <tr>
        <td>${row.character_name}</td>
        <td>${row.item_name}<input type="hidden" name="item_name" value="${row.item_name}"></td>
        <td class="number">${row.type_id || ''}<input type="hidden" name="type_id" value="${row.type_id || ''}"></td>
        <td class="number">${row.quantity}<input type="hidden" name="quantity" value="${row.quantity}"></td>
        <td>${row.price_source}</td>
        <td class="number">${isk(row.jita_price)}<input type="hidden" name="jita_price" value="${row.jita_price || 0}"></td>
        <td>${row.price_note || ''}</td>
        <td class="number">${pyFloat(row.valuation_percentage)}</td>
        <td class="number">${isk(row.calculated_value)}</td>
      </tr>`)}
      <tr><th colspan="8">Total Loot Value</th><th class="number">${isk(c.preview_total)}</th></tr>
    </table>
    <p>
      ${c.calculated ? html`
        <button type="submit">Confirm Add All Loot</button>
        <a class="button secondary" href="/loot">Cancel</a>` : html`
        <button type="submit">Get ESI Prices / Calculate Values</button>
        <a class="button secondary" href="/loot">Cancel</a>`}
    </p>
  </form>
</div>` : ''}

<div class="card">
  <h3>Recent Loot Entries</h3>
  <table>
    <tr><th>Local Time</th><th>EVE Time</th><th>Character</th><th>Session</th><th>Activity</th><th>Item</th><th>Qty</th><th>Source</th><th>Price</th><th>%</th><th>Value</th><th></th></tr>
    ${c.entries.length ? c.entries.map((e) => html`
      <tr>
        <td>${e.loot_date ? formatLocal(e.loot_date, c.timezone_name) : ''}</td>
        <td>${e.loot_date ? formatUtc(e.loot_date) : ''}</td>
        <td>${c.character_map.get(Number(e.character_id)) ?? (e.character_id || '')}</td>
        <td>${e.session_id ? `#${e.session_id}` : html`<span class="muted">Unmatched</span>`}</td>
        <td>${e.activity_type || ''}</td>
        <td>${e.item_name}</td>
        <td class="number">${e.quantity}</td>
        <td>${e.price_source}</td>
        <td class="number">${isk(e.jita_price)}</td>
        <td class="number">${pyFloat(e.valuation_percentage)}</td>
        <td class="number">${isk(e.calculated_value)}</td>
        <td><form method="post" action="/loot/${e.id}/delete" onsubmit="return confirm('Delete this loot entry? Dashboard and session totals will update automatically.')"><button type="submit">Delete</button></form></td>
      </tr>`) : html`
      <tr><td colspan="12">No loot entries yet.</td></tr>`}
  </table>
</div>`;
}

// ---------- Reports ----------

export function reportsPage(c) {
  const rate = (r) => (r.hours ? r.total / r.hours : 0);
  return html`
<div class="card">
  <h2>Reports</h2>
  <p class="muted">Reports use your browser timezone: ${c.timezone_name}.</p>
  <form method="get" class="filters">
    <div>
      <label>Date Range</label>
      <select name="range" onchange="this.form.submit()">
        ${RANGE_OPTIONS.map(([v, l]) => opt(v, l, c.selected_range === v))}
      </select>
    </div>
    <div>
      <label>Start Date</label>
      <input type="date" name="start_date" value="${c.start_date}">
    </div>
    <div>
      <label>End Date</label>
      <input type="date" name="end_date" value="${c.end_date}">
    </div>
    <div>
      <label>Character</label>
      <select name="character_id">
        <option value="">All Characters</option>
        ${c.characters.map((ch) => opt(ch.character_id, ch.character_name, String(c.selected_character_id) === String(ch.character_id)))}
      </select>
    </div>
    <div>
      <label>Activity</label>
      <select name="activity">
        ${['All', 'Ratting', 'Incursions', 'Missions'].map((a) => opt(a, a, c.selected_activity === a))}
      </select>
    </div>
    <div><label>&nbsp;</label><button>Apply</button></div>
  </form>
</div>

<div class="grid">
  <div class="card"><div class="muted">Wallet Income</div><div class="metric">${isk(c.total_wallet)}</div></div>
  <div class="card"><div class="muted">Loot Value</div><div class="metric">${isk(c.total_loot)}</div></div>
  <div class="card"><div class="muted">Total Value</div><div class="metric">${isk(c.total_value)}</div></div>
  <div class="card"><div class="muted">ISK / Hour</div><div class="metric">${isk(c.isk_hour)}</div></div>
</div>

<div class="card">
  <h3>CSV Exports</h3>
  <p>
    <a class="button" href="/reports/export?${c.qs('sessions')}">Export Sessions CSV</a>
    <a class="button" href="/reports/export?${c.qs('characters')}">Export Character CSV</a>
    <a class="button" href="/reports/export?${c.qs('activity')}">Export Activity CSV</a>
    <a class="button" href="/reports/export?${c.qs('raw_wallet')}">Export Raw Wallet CSV</a>
    <a class="button" href="/reports/export?${c.qs('loot')}">Export Loot CSV</a>
  </p>
</div>

<div class="card">
  <h3>Activity Report</h3>
  <table>
    <tr><th>Activity</th><th>Sessions</th><th>Wallet</th><th>Loot</th><th>Total</th><th>Hours</th><th>ISK/Hour</th></tr>
    ${c.activity_rows.length ? c.activity_rows.map((r) => html`
      <tr><td>${r.activity}</td><td>${r.sessions}</td><td>${isk(r.wallet)}</td><td>${isk(r.loot)}</td><td>${isk(r.total)}</td><td>${fixed2(r.hours)}</td><td>${isk(rate(r))}</td></tr>`) : html`<tr><td colspan="7">No activity found for this filter.</td></tr>`}
  </table>
</div>

<div class="card">
  <h3>Character Contribution Report</h3>
  <table>
    <tr><th>Character</th><th>Sessions</th><th>Wallet</th><th>Loot</th><th>Total</th><th>Ratting</th><th>Incursions</th><th>Missions</th><th>Hours</th><th>ISK/Hour</th></tr>
    ${c.character_rows.length ? c.character_rows.map((r) => html`
      <tr><td>${r.character}</td><td>${r.sessions}</td><td>${isk(r.wallet)}</td><td>${isk(r.loot)}</td><td>${isk(r.total)}</td><td>${isk(r.Ratting)}</td><td>${isk(r.Incursions)}</td><td>${isk(r.Missions)}</td><td>${fixed2(r.hours)}</td><td>${isk(rate(r))}</td></tr>`) : html`<tr><td colspan="10">No character income found for this filter.</td></tr>`}
  </table>
</div>

<div class="card">
  <h3>Session Report</h3>
  <table>
    <tr><th>Session</th><th>Character</th><th>Activity</th><th>Start</th><th>End</th><th>Wallet</th><th>Loot</th><th>Total</th></tr>
    ${c.sessions.length ? c.sessions.map((s) => html`
      <tr><td><a href="/sessions/${s.id}">#${s.id}</a></td><td>${c.character_map.get(Number(s.source_character_id)) ?? s.source_character_id}</td><td>${s.activity_type}</td><td>${formatLocal(s.start_time, c.timezone_name)}</td><td>${formatLocal(s.end_time, c.timezone_name)}</td><td>${isk(s.wallet_income)}</td><td>${isk(s.loot_value)}</td><td>${isk(s.total_value)}</td></tr>`) : html`<tr><td colspan="8">No sessions found for this filter.</td></tr>`}
  </table>
</div>`;
}

// ---------- Settings ----------

export const settingsPage = ({ price_sources, loot_price_source, loot_valuation_percentage }) => html`
<div class="card">
  <h2>Settings</h2>
  <p class="muted">Application settings stored in the D1 database. Secrets are stored as Cloudflare Worker secrets.</p>
</div>
<div class="card">
  <h3>Loot Valuation Defaults</h3>
  <form method="post" action="/settings/loot">
    <label>Default Loot Price Source</label>
    <select name="price_source">
      ${price_sources.map((src) => html`<option${sel(src === loot_price_source)}>${src}</option>`)}
    </select>
    <label>Default Valuation Percentage</label>
    <input name="valuation_percentage" type="number" step="0.01" min="0" value="${loot_valuation_percentage}">
    <p><button>Save Loot Settings</button></p>
  </form>
</div>`;
