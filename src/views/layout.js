import { html, raw } from '../html.js';

// Browser timezone detection and the Auto Sync widget, unchanged from base.html.
const AUTO_SYNC_SCRIPT = raw(`<script>
(function () {
  const widget = document.getElementById("auto-sync-widget");
  const toggle = document.getElementById("auto-sync-toggle");
  const statusEl = document.getElementById("auto-sync-status");
  if (!widget || !toggle || !statusEl) return;

  let autoEnabled = false;
  let secondsRemaining = null;
  let syncInProgress = false;

  function fmtSeconds(seconds) {
    seconds = Math.max(0, Math.floor(seconds || 0));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return h + "h " + String(m).padStart(2, "0") + "m";
    if (m > 0) return m + "m " + String(s).padStart(2, "0") + "s";
    return s + "s";
  }

  function render(data) {
    if (!data || data.authenticated === false) return;
    autoEnabled = !!data.auto_enabled;
    secondsRemaining = Number(data.seconds_remaining || 0);
    toggle.textContent = autoEnabled ? "Auto Sync: ON" : "Auto Sync: OFF";
    toggle.classList.toggle("enabled", autoEnabled);
    if (syncInProgress) {
      statusEl.textContent = "Syncing...";
    } else if (!autoEnabled) {
      statusEl.textContent = "Off";
    } else if (data.allowed) {
      statusEl.textContent = "Ready";
    } else {
      statusEl.textContent = "Next sync: " + fmtSeconds(secondsRemaining);
    }
  }

  async function getStatus() {
    try {
      const response = await fetch("/api/sync/status", {credentials: "same-origin"});
      if (!response.ok) return;
      const data = await response.json();
      render(data);
      if (data.auto_enabled && data.allowed) {
        await runAutoSync();
      }
    } catch (e) {}
  }

  async function runAutoSync() {
    if (syncInProgress) return;
    syncInProgress = true;
    statusEl.textContent = "Syncing...";
    try {
      const response = await fetch("/api/sync/auto-run", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        credentials: "same-origin",
        body: JSON.stringify({})
      });
      if (!response.ok) return;
      const data = await response.json();
      render(data);
      if (data.ran) {
        statusEl.textContent = (data.inserted_total && data.inserted_total > 0)
          ? "Imported " + data.inserted_total + " entries. Refreshing..."
          : "No new entries.";
        if (data.inserted_total && data.inserted_total > 0) {
          setTimeout(function () { window.location.reload(); }, 1500);
        }
      }
    } catch (e) {
      statusEl.textContent = "Auto sync error";
    } finally {
      syncInProgress = false;
    }
  }

  toggle.addEventListener("click", async function () {
    try {
      const response = await fetch("/api/sync/auto-toggle", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        credentials: "same-origin",
        body: JSON.stringify({enabled: !autoEnabled})
      });
      if (!response.ok) return;
      const data = await response.json();
      render(data);
      if (data.auto_enabled && data.allowed) {
        await runAutoSync();
      }
    } catch (e) {}
  });

  setInterval(function () {
    if (autoEnabled && secondsRemaining !== null && secondsRemaining > 0) {
      secondsRemaining -= 1;
      statusEl.textContent = "Next sync: " + fmtSeconds(secondsRemaining);
    }
  }, 1000);

  setInterval(getStatus, 60000);
  getStatus();
})();
</script>`);

const TABS = [
  ['/', 'Dashboard'],
  ['/sessions', 'Sessions'],
  ['/loot', 'Loot'],
  ['/reports', 'Reports'],
  ['/raw-data', 'Raw Data'],
  ['/sync', 'Wallet Sync'],
  ['/characters', 'Characters'],
  ['/settings', 'Settings'],
  ['/about', 'About'],
];

function isActive(tab, path) {
  if (tab === '/') return path === '/';
  return path === tab || path.startsWith(`${tab}/`);
}

export const portrait = (characterId, size = 64) =>
  `https://images.evetech.net/characters/${encodeURIComponent(characterId)}/portrait?size=${size}`;

/**
 * Page shell (was base.html), styled like EveAssets.
 * @param {import('../session.js').Session} session
 */
export function layout(session, content, title = null) {
  const loggedIn = session.userId() !== null;
  const currentTz = session.get('timezone', '');
  const path = session.path || '/';
  const charId = session.get('user_character_id');
  return html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title || 'EveWallet'}</title>
  <link rel="stylesheet" href="/static/css/app.css">
</head>
<body>
<header class="topbar">
  <a class="brand" href="/">Eve<b>Wallet</b></a>
  ${loggedIn ? html`
  <span id="auto-sync-widget" class="auto-sync-widget" title="Automatically sync wallet data when the ESI sync cooldown allows it.">
    <span id="auto-sync-status" class="auto-sync-status">Checking...</span>
    <button id="auto-sync-toggle" type="button" class="auto-sync-toggle">Auto Sync: ...</button>
  </span>
  <span class="who">
    ${charId ? html`<img src="${portrait(charId, 64)}" alt="" onerror="this.style.visibility='hidden'">` : ''}
    <span><b>${session.get('user_character_name')}</b><br><span class="tz">${session.get('timezone', 'detecting...')}</span></span>
  </span>
  <a class="button" href="/auth/logout">Log out</a>` : html`
  <a class="button primary" href="/auth/login">Log in with EVE</a>`}
</header>
${loggedIn ? html`<nav class="tabs">${TABS.map(([href, label]) => html`<a href="${href}"${isActive(href, path) ? html` class="on"` : ''}>${label}</a>`)}</nav>` : ''}
<main>${content}</main>
<script>
(function () {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const current = ${raw(JSON.stringify(String(currentTz)).replace(/</g, '\\u003c'))};
    if (tz && tz !== current) {
      const body = new URLSearchParams();
      body.append("timezone_name", tz);
      fetch("/timezone", {
        method: "POST",
        headers: {"Content-Type": "application/x-www-form-urlencoded"},
        body: body.toString(),
        credentials: "same-origin"
      }).then(function () {
        if (!current) window.location.reload();
      }).catch(function () {});
    }
  } catch (e) {}
})();
</script>
${AUTO_SYNC_SCRIPT}
</body>
</html>`;
}
