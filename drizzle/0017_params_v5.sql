-- Params v5 (hand-written, like 0015): adds the IV-source and IV-floor thresholds of volatility.edge
-- (docs/designs/trade-skills-integration.md T3) by MERGING them into the latest stored 'default' version rather than
-- restating the code defaults, so a Settings-edited database keeps its edits. On a fresh database the merged row equals
-- the code defaults (tests/db/migrations.test.ts). The hash column holds the hash of the code defaults; the loader
-- recomputes the hash from the stored params on every read.
INSERT INTO "strategy_params" ("name", "version", "params", "params_hash", "note")
SELECT 'default',
       5,
       jsonb_set(
         "params",
         '{volatility.edge}',
         coalesce("params"->'volatility.edge', '{}'::jsonb)
           || '{"ivSourceEventDays":14,"ivSourceFrontHeavyMin":1.02,"ivSourceDemandDays":45,"ivFloorPercentileMax":10,"ivFloorRampMinDays":30,"ivFloorRampMaxDays":60}'::jsonb
       ),
       'cdb997e0e648a3815d47e30ee620b5ee',
       'v5: IV-source and IV-floor thresholds in volatility.edge (ivSourceEventDays 14, ivSourceFrontHeavyMin 1.02, ivSourceDemandDays 45, ivFloorPercentileMax 10, ivFloorRampMinDays 30, ivFloorRampMaxDays 60), 2026-10-19'
FROM "strategy_params"
WHERE "name" = 'default'
  AND "version" = (SELECT max("version") FROM "strategy_params" WHERE "name" = 'default')
  AND NOT EXISTS (SELECT 1 FROM "strategy_params" WHERE "name" = 'default' AND "version" = 5);
