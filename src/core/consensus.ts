/**
 * Generic consensus utility for getting reliable results from multiple queries.
 * Supports early exit once sufficient agreement is reached.
 */

import { getSamplingParams, type SamplingParams } from "./retry.js";

export interface ConsensusConfig {
  maxQueries: number;
  minMatches: number;
  matchMode: "exact" | "some";
  stop?: string[];
}

export interface ConsensusResult<T> {
  result: T | undefined;
  matchCount: number;
  queriesRun: number;
  allResults: T[];
}

const DEFAULT_CONFIG: ConsensusConfig = {
  maxQueries: 3,
  minMatches: 2,
  matchMode: "some",
};

/**
 * Deep equality check for "exact" match mode.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== "object") return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }

  if (Array.isArray(a) !== Array.isArray(b)) return false;

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;

  return aKeys.every((key) => deepEqual(aObj[key], bObj[key]));
}

/**
 * Count how many results match a candidate using the provided compare function.
 */
function countMatches<T>(
  candidate: T,
  results: T[],
  compareFn: (a: T, b: T) => boolean
): number {
  return results.filter((r) => compareFn(candidate, r)).length;
}

/**
 * Find the result with the most matches.
 */
function findBestCandidate<T>(
  results: T[],
  compareFn: (a: T, b: T) => boolean
): { result: T; matchCount: number } | undefined {
  if (results.length === 0) return undefined;

  let best: T = results[0]!;
  let bestCount = 0;

  for (const candidate of results) {
    const count = countMatches(candidate, results, compareFn);
    if (count > bestCount) {
      bestCount = count;
      best = candidate;
    }
  }

  return { result: best, matchCount: bestCount };
}

/**
 * Run queries with consensus, supporting early exit.
 *
 * @param queryFn - Function to run a query with sampling params
 * @param compareFn - Function to compare two results (for "some" mode, return true if they partially match)
 * @param config - Consensus configuration
 *
 * For matchMode "exact", compareFn is ignored and deep equality is used.
 * For matchMode "some", compareFn should return true if results have sufficient overlap.
 */
export async function runWithConsensus<T>(
  queryFn: (params: SamplingParams) => Promise<T | null>,
  compareFn: (a: T, b: T) => boolean,
  config: Partial<ConsensusConfig> = {}
): Promise<ConsensusResult<T>> {
  const { maxQueries, minMatches, matchMode, stop } = {
    ...DEFAULT_CONFIG,
    ...config,
  };

  const compare: (a: T, b: T) => boolean =
    matchMode === "exact" ? deepEqual : compareFn;

  const results: T[] = [];
  let queriesRun = 0;

  for (let i = 0; i < maxQueries; i++) {
    queriesRun++;
    const params = getSamplingParams(i, stop);
    const result = await queryFn(params);

    if (result !== null) {
      results.push(result);

      // Check if we have consensus early
      const best = findBestCandidate(results, compare);
      if (best && best.matchCount >= minMatches) {
        return {
          result: best.result,
          matchCount: best.matchCount,
          queriesRun,
          allResults: results,
        };
      }
    }
  }

  // No early consensus - find best result from all
  const best = findBestCandidate(results, compare);

  return {
    result: best?.result,
    matchCount: best?.matchCount ?? 0,
    queriesRun,
    allResults: results,
  };
}

/**
 * Helper to check if two arrays have any overlap (for "some" mode with array results).
 */
export function arraysOverlap<T>(a: T[], b: T[]): boolean {
  return a.some((item) => b.includes(item));
}

/**
 * Helper to check if arrays have at least N elements in common.
 */
export function arraysShareAtLeast<T>(a: T[], b: T[], n: number): boolean {
  const common = a.filter((item) => b.includes(item));
  return common.length >= n;
}
