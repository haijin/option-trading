import type { ReportingFrequency, SolvencyModel } from '../../api/types';

export const SOLVENCY_OPTIONS: { id: SolvencyModel; label: string }[] = [
  { id: 'altman', label: 'altman: industrials, tech, consumer' },
  { id: 'property', label: 'property: developers and landlords' },
  { id: 'financial', label: 'financial: banks and insurers' },
  { id: 'reit', label: 'reit: real estate trusts' },
];

export const FREQUENCY_OPTIONS: { id: ReportingFrequency; label: string }[] = [
  { id: 'quarterly', label: 'quarterly' },
  { id: 'semiannual', label: 'semiannual (most HK names)' },
];
