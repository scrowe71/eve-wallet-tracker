// EVE Wallet Tracker on Cloudflare Workers + D1.
//
// Routes and behaviour match the original FastAPI app (app/main.py and app/routers/*).

import { Session } from './session.js';
import { redirect, text } from './http.js';
import * as auth from './routes/auth.js';
import * as core from './routes/core.js';
import * as data from './routes/data.js';
import * as loot from './routes/loot.js';

// [method, pattern, handler]. Patterns may contain one ":param".
const ROUTES = [
  ['GET', '/auth/login', auth.login],
  ['GET', '/auth/add-character', auth.addCharacter],
  ['GET', '/auth/logout', auth.logout],
  ['GET', '/auth/callback', auth.callback],
  ['POST', '/timezone', core.setTimezone],

  ['GET', '/', core.dashboard],
  ['GET', '/characters', core.characters],
  ['GET', '/sync', core.syncPageHandler],
  ['POST', '/sync', core.syncAll],
  ['POST', '/sync/rebuild-sessions', core.rebuildSessionsOnly],
  ['GET', '/api/sync/status', core.apiSyncStatus],
  ['POST', '/api/sync/auto-toggle', core.apiAutoToggle],
  ['POST', '/api/sync/auto-run', core.apiAutoRun],
  ['GET', '/settings', core.settingsHandler],
  ['POST', '/settings/loot', core.saveLootSettings],
  ['GET', '/about', core.about],

  ['GET', '/raw-data', data.rawData],
  ['GET', '/raw-data/export', data.rawDataExport],
  ['GET', '/sessions', data.sessionsList],
  ['POST', '/sessions/rebuild', data.sessionsRebuild],
  ['GET', '/sessions/fleet', data.fleetSessionDetail],
  ['GET', '/sessions/:id', data.sessionDetail],
  ['GET', '/reports', data.reports],
  ['GET', '/reports/export', data.reportsExport],

  ['GET', '/loot', loot.lootIndex],
  ['POST', '/loot', loot.lootAdd],
  ['POST', '/loot/preview', loot.lootPreview],
  ['POST', '/loot/calculate', loot.lootCalculate],
  ['POST', '/loot/manual', loot.lootManual],
  ['POST', '/loot/:id/delete', loot.lootDelete],
];

function match(method, path) {
  let pathMatched = false;
  for (const [m, pattern, handler] of ROUTES) {
    const pp = pattern.split('/');
    const ap = path.split('/');
    if (pp.length !== ap.length) continue;
    let param = null;
    let ok = true;
    for (let i = 0; i < pp.length; i++) {
      if (pp[i].startsWith(':')) param = decodeURIComponent(ap[i]);
      else if (pp[i] !== ap[i]) { ok = false; break; }
    }
    if (!ok) continue;
    pathMatched = true;
    if (m === method || (method === 'HEAD' && m === 'GET')) return { handler, param };
  }
  return pathMatched ? { methodNotAllowed: true } : null;
}

// Pages anyone can reach without logging in: SSO, static files and timezone detection.
const isPublicPath = (path) => path.startsWith('/auth/') || path.startsWith('/static/') || path === '/favicon.ico' || path === '/timezone';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let path = url.pathname;
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);

    let session;
    try {
      session = await Session.load(request, env.SECRET_KEY);
    } catch (err) {
      return text(String(err.message || err), 500);
    }

    // Every application page and data route requires an EVE SSO login.
    const userId = session.userId();
    let response;
    if (!isPublicPath(path) && userId === null) {
      response = request.method === 'GET' || request.method === 'HEAD' ? redirect('/auth/login') : text('Login required', 401);
      return session.commit(response);
    }

    const route = match(request.method, path);
    if (!route) response = new Response(JSON.stringify({ detail: 'Not Found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    else if (route.methodNotAllowed) response = new Response(JSON.stringify({ detail: 'Method Not Allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
    else {
      const req = { request, env, url, session, userId };
      try {
        response = await route.handler(req, route.param);
      } catch (err) {
        console.error(`${request.method} ${path} failed:`, err && err.stack ? err.stack : err);
        response = text('Internal Server Error', 500);
      }
    }
    return session.commit(response);
  },
};
