/**
 * Dictionary builder for hear-say STT correction.
 *
 * Builds a weighted dictionary from tools and status for phonetic matching.
 * Higher weights = higher priority when scores are close.
 */

import { removeStopwords } from "stopword";
import type { DictionaryEntry } from "hear-say";
import type { InventoryEntry } from "../utils/tools.js";

/**
 * Check if a term is a valid speakable word for STT.
 * Filters out pure numbers, symbols, and technical codes.
 */
function isValidTerm(term: string): boolean {
  // Must have at least 3 letters
  const letterCount = (term.match(/[a-zA-Z]/g) ?? []).length;
  if (letterCount < 3) return false;

  // Filter out technical error codes (all caps with numbers/underscores)
  if (/^[A-Z][A-Z0-9_]+$/.test(term) && term.length > 6) return false;

  return true;
}

/**
 * Tokenize text into words, splitting on common delimiters.
 */
function tokenize(text: string): string[] {
  return text
    .split(/[\s_\-:,./()[\]{}'"]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3);
}

/**
 * Filter stopwords from word list.
 */
function filterStopwords(words: string[]): string[] {
  return removeStopwords(words);
}

/**
 * Build dictionary from tool inventory and status info.
 *
 * Weight tiers:
 * - Status words: 1.0 (current context, highest relevance)
 * - Tool names: 0.9 (core commands)
 * - Tool argument names: 0.8 (parameter names)
 * - Tool descriptions: 0.7 (context words from docs)
 * - Tool argument descriptions: 0.6 (less likely to be spoken)
 */
export function buildDictionary(
  toolInventory: InventoryEntry[],
  statusInfo: string
): DictionaryEntry[] {
  const seen = new Set<string>();
  const entries: DictionaryEntry[] = [];

  const add = (term: string, weight: number): void => {
    const lower = term.toLowerCase();
    if (!seen.has(lower) && term.length >= 3 && isValidTerm(term)) {
      seen.add(lower);
      entries.push({ term, weight });
    }
  };

  // 1. Status words (weight: 1.0)
  const statusTokens = tokenize(statusInfo);
  const filteredStatus = filterStopwords(statusTokens);
  for (const word of filteredStatus) {
    add(word, 1);
  }

  // 2. Tool names (weight: 0.9)
  for (const entry of toolInventory) {
    add(entry.openAi.function.name, 0.9);
  }

  // 3. Tool argument names (weight: 0.8)
  for (const entry of toolInventory) {
    const props = entry.openAi.function.parameters?.properties ?? {};
    for (const paramName of Object.keys(props)) {
      add(paramName, 0.8);
    }
  }

  // 4. Tool descriptions (weight: 0.7)
  for (const entry of toolInventory) {
    const desc = entry.openAi.function.description;
    if (desc) {
      const tokens = tokenize(desc);
      const filtered = filterStopwords(tokens);
      for (const word of filtered) {
        add(word, 0.7);
      }
    }
  }

  // 5. Tool argument descriptions (weight: 0.6)
  for (const entry of toolInventory) {
    const props = entry.openAi.function.parameters?.properties ?? {};
    for (const prop of Object.values(props)) {
      const desc = (prop as { description?: string }).description;
      if (desc) {
        const tokens = tokenize(desc);
        const filtered = filterStopwords(tokens);
        for (const word of filtered) {
          add(word, 0.6);
        }
      }
    }
  }

  return entries;
}
