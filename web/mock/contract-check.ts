/**
 * Compile-time guard for the request bodies. Responses are typed where they are built (every builder returns its
 * contract type); request bodies are parsed from untyped JSON, so this file pins their field lists. When
 * src/server/api-types.ts adds, removes or renames a body field, `pnpm exec tsc -p web/mock/tsconfig.json` fails here and
 * the matching parser (watchlist.ts, positions.ts, dataops.ts, ...) has to be updated.
 */
import type {
  ChainImportInput,
  EventAddInput,
  FairValueImportInput,
  IngestStartInput,
  JournalEntryInput,
  JournalImportInput,
  LeaderMuteInput,
  PositionAddInput,
  PositionCloseInput,
  ResearchStartInput,
  SettingsPatch,
  ValuationOverrides,
  WatchAddInput,
  WatchBulkInput,
  WatchPatch,
} from '../../src/server/api-types';

type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

export type BodyFieldChecks = [
  Expect<
    Same<
      keyof WatchAddInput,
      | 'symbol'
      | 'market'
      | 'boardLot'
      | 'solvencyModel'
      | 'reportingFrequency'
      | 'conviction'
      | 'notes'
      | 'maxCollateralPct'
    >
  >,
  Expect<
    Same<
      keyof WatchPatch,
      | 'active'
      | 'boardLot'
      | 'solvencyModel'
      | 'reportingFrequency'
      | 'conviction'
      | 'notes'
      | 'maxCollateralPct'
      | 'name'
    >
  >,
  Expect<Same<keyof WatchBulkInput, 'op' | 'keys'>>,
  Expect<
    Same<
      keyof PositionAddInput,
      'symbol' | 'market' | 'strike' | 'expiry' | 'contracts' | 'price' | 'date' | 'fees' | 'spot'
    >
  >,
  Expect<Same<keyof PositionCloseInput, 'kind' | 'price' | 'date' | 'fees' | 'underlyingClose'>>,
  Expect<Same<keyof JournalImportInput, 'csv'>>,
  Expect<Same<keyof JournalEntryInput, 'title' | 'template' | 'marketView' | 'tags' | 'doc' | 'revisionNo' | 'source'>>,
  Expect<Same<keyof SettingsPatch, 'equity' | 'baseCurrency'>>,
  Expect<Same<keyof IngestStartInput, 'only'>>,
  Expect<Same<keyof ChainImportInput, 'symbol' | 'market' | 'csv' | 'spot' | 'date'>>,
  Expect<Same<keyof EventAddInput, 'symbol' | 'market' | 'type' | 'date' | 'confirmed'>>,
  Expect<Same<keyof FairValueImportInput, 'csv' | 'asOf'>>,
  Expect<Same<keyof ResearchStartInput, 'symbol' | 'market' | 'skillIds'>>,
  Expect<Same<keyof LeaderMuteInput, 'days' | 'reason'>>,
  Expect<Same<keyof ValuationOverrides, 'growthPct' | 'targetPe' | 'dcfGrowthPct' | 'requiredReturnPct'>>,
];
