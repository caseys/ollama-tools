/**
 * STT Pre-processor.
 *
 * Uses phonetics package for simple phonetic matching of STT-misheard
 * words against known terms from tools and status.
 *
 * Only runs when inputSource === "voice".
 */

import phonetics from "phonetics";
import type { InventoryEntry } from "../utils/tools.js";
import { levenshteinDistance } from "../utils/strings.js";
import {
  buildFromToolCatalog,
  buildFromStatusText,
  combineDictionaries,
  type DictionaryEntry,
} from "./dictionary.js";

// === Scoring helpers ===

/**
 * Get Double Metaphone phonetic codes for a word.
 */
function getPhoneticCodes(word: string): [string, string] {
  const codes = phonetics.doubleMetaphone(word);
  return [codes[0] ?? "", codes[1] ?? ""];
}

/**
 * Score phonetic similarity (0-1, higher = better).
 * Uses fuzzy matching on phonetic codes - allows near-matches.
 */
function phoneticScore(word1: string, word2: string): number {
  const [p1, s1] = getPhoneticCodes(word1);
  const [p2, s2] = getPhoneticCodes(word2);

  // Compare all code combinations and take best match
  const scores: number[] = [];

  for (const c1 of [p1, s1]) {
    for (const c2 of [p2, s2]) {
      if (!c1 || !c2) continue;
      if (c1 === c2) {
        scores.push(1.0); // Exact match
      } else {
        // Fuzzy match based on Levenshtein distance of codes
        const dist = levenshteinDistance(c1, c2);
        const maxLen = Math.max(c1.length, c2.length);
        const similarity = 1 - dist / maxLen;
        scores.push(similarity);
      }
    }
  }

  return scores.length > 0 ? Math.max(...scores) : 0;
}

/**
 * Score text similarity using Levenshtein (0-1, higher = better).
 */
function textScore(word1: string, word2: string): number {
  const dist = levenshteinDistance(word1.toLowerCase(), word2.toLowerCase());
  const maxLen = Math.max(word1.length, word2.length);
  return maxLen > 0 ? 1 - dist / maxLen : 1;
}

/**
 * Check if phonetic codes are similar enough to consider a match.
 * More lenient than doubleMetaphoneMatch - allows 1-2 char difference.
 */
function isPhoneticallySimilar(word1: string, word2: string): boolean {
  const [p1, s1] = getPhoneticCodes(word1);
  const [p2, s2] = getPhoneticCodes(word2);

  for (const c1 of [p1, s1]) {
    for (const c2 of [p2, s2]) {
      if (!c1 || !c2) continue;
      if (c1 === c2) return true;
      // Allow up to 2 character difference in phonetic codes
      const dist = levenshteinDistance(c1, c2);
      if (dist <= 2) return true;
    }
  }
  return false;
}

// Common words to skip in INPUT (don't try to correct these)
const INPUT_SKIP_WORDS = new Set([
  // Articles, conjunctions, prepositions - general words that shouldn't be corrected
  "a", "an", "the", "and", "or", "but", "to", "of", "in", "on", "at",
  "for", "with", "by", "from", "then", "than", "so", "if", "as", "is",
  "it", "be", "do", "go", "no", "up", "my", "we", "he", "me", "us",
]);

/**
 * Convert InventoryEntry array to abstract tool catalog format.
 */
function extractToolTexts(toolInventory: InventoryEntry[]): Array<{
  name: string;
  description?: string;
  paramNames?: string[];
  enumValues?: string[];
}> {
  return toolInventory.map((entry) => {
    const func = entry.openAi.function;
    const props = func.parameters?.properties ?? {};

    const paramNames: string[] = [];
    const enumValues: string[] = [];

    for (const [paramName, paramSchema] of Object.entries(props)) {
      paramNames.push(paramName);
      const schema = paramSchema as { enum?: string[] };
      if (schema.enum) {
        enumValues.push(...schema.enum.filter((v): v is string => typeof v === "string"));
      }
    }

    return {
      name: func.name,
      description: func.description,
      paramNames,
      enumValues,
    };
  });
}

/**
 * Build dictionary from tool inventory and status text.
 */
function buildDictionary(
  toolInventory: InventoryEntry[],
  statusInfo: string
): DictionaryEntry[] {
  const toolTexts = extractToolTexts(toolInventory);
  const toolEntries = buildFromToolCatalog(toolTexts);
  const statusEntries = buildFromStatusText(statusInfo);
  return combineDictionaries(toolEntries, statusEntries);
}

/**
 * Tokenize sentence into words.
 */
function tokenizeWords(sentence: string): string[] {
  return sentence
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0);
}

/**
 * Check if input word should be skipped (common words, numbers, etc.)
 */
function shouldSkipInputWord(word: string): boolean {
  const lower = word.toLowerCase();
  if (INPUT_SKIP_WORDS.has(lower)) return true;
  if (lower.length < 3) return true;
  if (/^\d+$/.test(lower)) return true;
  return false;
}

/**
 * Find phonetic match with scoring.
 * Uses doubleMetaphoneMatch as filter, then scores by:
 * - Phonetic code similarity (40%)
 * - Text similarity (40%)
 * - Dictionary weight (20%)
 */
function findPhoneticMatch(
  token: string,
  dictionary: DictionaryEntry[],
  debug: (msg: string) => void
): DictionaryEntry | undefined {
  const tokenLower = token.toLowerCase();

  // Collect matches with scores
  const matches: Array<{ entry: DictionaryEntry; score: number }> = [];

  for (const entry of dictionary) {
    const entryLower = entry.term.toLowerCase();

    // Skip if same word
    if (tokenLower === entryLower) continue;

    // First filter: must be phonetically similar (fuzzy phonetic match)
    if (!isPhoneticallySimilar(tokenLower, entryLower)) continue;

    // Score the match
    const pScore = phoneticScore(tokenLower, entryLower);
    const tScore = textScore(tokenLower, entryLower);

    // Combined score: phonetic (40%) + text (40%) + weight (20%)
    const combined = pScore * 0.4 + tScore * 0.4 + entry.weight * 0.2;

    matches.push({ entry, score: combined });
  }

  if (matches.length === 0) return undefined;

  // Sort by score descending
  matches.sort((a, b) => b.score - a.score);

  const best = matches[0]!;

  // Require minimum score to avoid weak matches
  // Also require phonetic score > text score (should sound more alike than look alike)
  const MIN_SCORE = 0.65;
  if (best.score < MIN_SCORE) return undefined;

  debug(`  phonetic: "${token}" → "${best.entry.term}" (score: ${best.score.toFixed(2)})`);

  return best.entry;
}

/**
 * Process tokens with phonetic matching.
 *
 * Strategy:
 * 1. Skip noise words (and, the, to, etc.)
 * 2. Skip words that already match dictionary exactly (case-insensitive)
 * 3. Try phonetic matching using metaphoneMatch
 */
function processTokens(
  tokens: string[],
  dictionary: DictionaryEntry[],
  debug: (msg: string) => void
): string[] {
  const corrected: string[] = [];
  const dictTermsLower = new Set(dictionary.map(e => e.term.toLowerCase()));

  for (const token of tokens) {
    if (!token) continue;

    // 1. Skip noise words
    if (shouldSkipInputWord(token)) {
      corrected.push(token);
      continue;
    }

    // 2. Skip words already in dictionary (exact match)
    if (dictTermsLower.has(token.toLowerCase())) {
      corrected.push(token);
      continue;
    }

    // 3. Try phonetic matching
    const phoneticMatch = findPhoneticMatch(token, dictionary, debug);
    if (phoneticMatch) {
      corrected.push(phoneticMatch.term);
      continue;
    }

    // No match found, keep original
    corrected.push(token);
  }

  return corrected;
}

export interface PreprocessResult {
  text: string;
  debugLog: string[];
}

/**
 * Pre-process STT input text.
 *
 * 1. Builds dictionary from tools + status
 * 2. For each word, phonetically matches against dictionary
 * 3. Returns corrected text
 */
export function preprocessSttInput(
  input: string,
  toolInventory: InventoryEntry[],
  statusInfo: string
): PreprocessResult {
  const debugLog: string[] = [];
  const debug = (msg: string) => debugLog.push(msg);

  if (!input.trim()) return { text: input, debugLog };

  const dictionary = buildDictionary(toolInventory, statusInfo);
  if (dictionary.length === 0) return { text: input, debugLog };

  debug(`Dictionary: ${dictionary.length} entries`);

  // Log a few sample entries
  const samples = dictionary.slice(0, 5);
  for (const s of samples) {
    debug(`  sample: "${s.term}" (weight: ${s.weight})`);
  }

  const tokens = tokenizeWords(input);
  const corrected = processTokens(tokens, dictionary, debug);

  return { text: corrected.join(" "), debugLog };
}
