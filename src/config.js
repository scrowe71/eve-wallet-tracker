// App settings. Non-secret values come from [vars] in wrangler.toml;
// EVE_CLIENT_SECRET, SECRET_KEY and JANICE_API_KEY are Worker secrets.

export function settings(env) {
  const num = (v, d) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
  return {
    APP_NAME: env.APP_NAME || 'EVE Wallet Tracker',
    EVE_CLIENT_ID: env.EVE_CLIENT_ID || '',
    EVE_CLIENT_SECRET: env.EVE_CLIENT_SECRET || '',
    EVE_CALLBACK_URL: env.EVE_CALLBACK_URL || 'https://evewallet.crankyape.space/auth/callback',
    SESSION_TIMEOUT_HOURS: num(env.SESSION_TIMEOUT_HOURS, 3),
    ESI_SYNC_COOLDOWN_MINUTES: num(env.ESI_SYNC_COOLDOWN_MINUTES, 60),
    DEFAULT_LOOT_PRICE_SOURCE: env.DEFAULT_LOOT_PRICE_SOURCE || 'Jita Buy',
    DEFAULT_LOOT_PERCENTAGE: num(env.DEFAULT_LOOT_PERCENTAGE, 95),
    JANICE_API_KEY: (env.JANICE_API_KEY || '').trim(),
  };
}

export const USER_AGENT = 'EVEWalletTracker/2.0 (evewallet.crankyape.space)';
export const ESI_BASE = 'https://esi.evetech.net';
export const ESI_COMPAT_DATE = '2025-09-30';
