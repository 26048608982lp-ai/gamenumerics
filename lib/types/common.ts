/**
 * Shared common types used across multiple modules.
 *
 * This file is the canonical source for BaseCurveType (CurveType).
 * All modules that define extended curve types (e.g. DifficultyCurveType,
 * level-system CurveType) must import from here and extend via union.
 */

/** Base curve growth model types — the canonical CurveType */
export type CurveType = 'linear' | 'exponential' | 'sigmoid';
