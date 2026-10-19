/**
 * The valuation module declares its own copies of the HTTP view types (it may not import from src/server). This file
 * proves, at compile time (`pnpm typecheck`), that each copy is assignable to its src/server/api-types.ts twin AND the
 * twin to the copy, so neither side can drift without a type error. The runtime test only gives the file a body.
 */
import { describe, expect, it } from 'vitest';
import type {
  AssumptionParam as ApiAssumptionParam,
  AssumptionsView as ApiAssumptionsView,
  IntrinsicView as ApiIntrinsicView,
  KpiGroup as ApiKpiGroup,
  KpiRowView as ApiKpiRowView,
  MethodView as ApiMethodView,
  QuarterRowView as ApiQuarterRowView,
  ScenarioView as ApiScenarioView,
  ScreenRowView as ApiScreenRowView,
  ScreenView as ApiScreenView,
  ValuationOverrides as ApiValuationOverrides,
} from '../../src/server/api-types';
import {
  buildFacts,
  defaultAssumptions,
  intrinsicValue,
  kpiRows,
  qualityScreen,
  quarterRows,
} from '../../src/valuation';
import type {
  AssumptionParam,
  AssumptionsView,
  IntrinsicView,
  KpiGroup,
  KpiRowView,
  MethodView,
  QuarterRowView,
  ScenarioView,
  ScreenRowView,
  ScreenView,
  ValuationOverrides,
} from '../../src/valuation/types';
import { input } from './helpers';

/** `true` only when A and B are assignable to each other. */
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const checks: {
  kpiGroup: Mutual<KpiGroup, ApiKpiGroup>;
  kpiRow: Mutual<KpiRowView, ApiKpiRowView>;
  quarterRow: Mutual<QuarterRowView, ApiQuarterRowView>;
  screenRow: Mutual<ScreenRowView, ApiScreenRowView>;
  screen: Mutual<ScreenView, ApiScreenView>;
  scenario: Mutual<ScenarioView, ApiScenarioView>;
  method: Mutual<MethodView, ApiMethodView>;
  assumptionParam: Mutual<AssumptionParam, ApiAssumptionParam>;
  assumptions: Mutual<AssumptionsView, ApiAssumptionsView>;
  intrinsic: Mutual<IntrinsicView, ApiIntrinsicView>;
  overrides: Mutual<ValuationOverrides, ApiValuationOverrides>;
} = {
  kpiGroup: true,
  kpiRow: true,
  quarterRow: true,
  screenRow: true,
  screen: true,
  scenario: true,
  method: true,
  assumptionParam: true,
  assumptions: true,
  intrinsic: true,
  overrides: true,
};

describe('valuation types match the HTTP contract', () => {
  it('every view is assignable to its api-types twin and back (checked by tsc)', () => {
    expect(Object.values(checks).every((x) => x === true)).toBe(true);
  });

  it('values produced by the module can be used as the contract types without a cast', () => {
    const facts = buildFacts(input());
    const kpis: ApiKpiRowView[] = kpiRows(facts);
    const quarters: ApiQuarterRowView[] = quarterRows(facts);
    const screen: ApiScreenView = qualityScreen(facts);
    const assumptions: ApiAssumptionsView = defaultAssumptions(facts);
    const overrides: ApiValuationOverrides = {
      growthPct: [10, 6, 2],
      targetPe: [20, 16, 12],
      dcfGrowthPct: 5,
      requiredReturnPct: 9,
    };
    const intrinsic: ApiIntrinsicView = intrinsicValue(facts, { requiredReturnPct: 8, overrides });
    // ... and the contract types can be passed back in.
    const back: ValuationOverrides = overrides;
    expect(kpis.length).toBeGreaterThan(0);
    expect(quarters).toEqual([]);
    expect(screen.rows).toHaveLength(7);
    expect(assumptions.terminalGrowthPct).toBe(3);
    expect(intrinsic.assumptions.growthPct[1].source).toBe('override');
    expect(back.requiredReturnPct).toBe(9);
  });
});
