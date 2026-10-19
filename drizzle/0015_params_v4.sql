-- Params v4 (hand-written, not from scripts/gen-params-migration.ts): adds the forward-aligned VRP thresholds of
-- volatility.edge (docs/designs/trade-skills-integration.md T1) by MERGING them into the latest stored 'default' version
-- rather than restating the code defaults. A database whose latest version was edited in Settings (maxPerNamePct,
-- for one) keeps those edits; a fresh database gets exactly the code defaults, which is what tests/db/migrations.test.ts
-- checks. The hash column holds the hash of the code defaults; the loader (src/db/repos.ts) recomputes the hash from
-- the stored params on every read, so a merged row with edits carries its real hash at run time.
INSERT INTO "strategy_params" ("name", "version", "params", "params_hash", "note")
SELECT 'default',
       4,
       jsonb_set(
         "params",
         '{volatility.edge}',
         coalesce("params"->'volatility.edge', '{}'::jsonb)
           || '{"vrpWindowDays":30,"vrpObservations":10,"vrpPositiveMin":6,"vrpNegativeMin":6}'::jsonb
       ),
       '812274d8277d4146538e8dd7ad78f2a5',
       'v4: forward-aligned VRP thresholds in volatility.edge (vrpWindowDays 30, vrpObservations 10, vrpPositiveMin 6, vrpNegativeMin 6), 2026-10-18'
FROM "strategy_params"
WHERE "name" = 'default'
  AND "version" = (SELECT max("version") FROM "strategy_params" WHERE "name" = 'default')
  AND NOT EXISTS (SELECT 1 FROM "strategy_params" WHERE "name" = 'default' AND "version" = 4);
