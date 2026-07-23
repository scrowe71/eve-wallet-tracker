# EVE Wallet Tracker - Dashboard Fleet Session Metrics Fix

This deployment package updates the Dashboard to use the same fleet-session grouping logic as the Sessions page.

## Fixes

- Dashboard Sessions count now reflects combined fleet sessions instead of per-character sessions.
- Dashboard ISK/hour now uses fleet session duration instead of summing each character's duration.
- Dashboard Wallet, Loot, and Total values remain based on the same underlying character sessions but are summarized using fleet-session groups.
- This aligns Dashboard metrics with the Sessions page when multiple characters participate in the same smartbombing/multibox session.

## Deploy

Replace:
- app/
- requirements.txt
- README.md

Do not replace:
- .env
- .env.example
- data/
- venv/

Restart the service after deployment:

```bash
cd /opt/evewallet
systemctl restart evewallet
systemctl status evewallet
```

No database migration is required.


## Manual loot value

The Loot page includes an Add Manual Loot Value form for entering an arbitrary ISK amount directly as loot value. Manual entries use `price_source = Manual ISK`, quantity 1, 100% valuation, and are matched to the current/latest session by character and timestamp.

## Manual Loot Latest Session / Distributed Chart Update

- Manual loot values attach to the latest matching/recent character session instead of staying unassigned.
- Manual loot values use `Manual ISK` as the source.
- Manual loot is included in session totals and loot totals.
- On the session chart, manual loot is distributed across the full effective session time instead of appearing as a single late spike.
- Normal itemized loot remains timestamped and grouped by batch timestamp.

## Unified loot/session update
- Manual ISK and itemized loot now use one current-session resolver.
- Unmatched loot is repaired when the Loot page opens and after session rebuilds.
- Janice URL imports are removed. Select **Janice Buy** as the price source when pasting itemized loot.
- Janice uses `POST https://janice.e-351.com/api/rest/v2/pricer?market=2` with the `X-ApiKey` header.
- Configure `JANICE_API_KEY` in `/opt/evewallet/.env` and restart the `evewallet` service.
