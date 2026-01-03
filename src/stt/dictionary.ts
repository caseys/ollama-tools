/**
 * Dictionary builder for STT fuzzy matching.
 *
 * Abstract text processing - takes raw text, extracts words,
 * builds dictionary for phonetic matching.
 */

export interface DictionaryEntry {
  term: string;           // The canonical term
  source: "tool" | "status";
  weight: number;         // Higher = prioritize
}

// Common noise words to filter out - these are too generic for STT correction
const NOISE_WORDS = new Set([
  // Articles & determiners
  "the", "a", "an", "this", "that", "these", "those",
  // Conjunctions
  "and", "or", "but", "nor", "yet", "so", "for",
  // Prepositions
  "in", "on", "at", "to", "for", "of", "with", "by", "from", "as",
  "into", "onto", "upon", "about", "above", "below", "under", "over",
  "between", "among", "through", "during", "before", "after", "since",
  "until", "while", "within", "without", "against", "toward", "towards",
  // Pronouns
  "i", "me", "my", "mine", "myself",
  "you", "your", "yours", "yourself",
  "he", "him", "his", "himself",
  "she", "her", "hers", "herself",
  "it", "its", "itself",
  "we", "us", "our", "ours", "ourselves",
  "they", "them", "their", "theirs", "themselves",
  "who", "whom", "whose", "which", "what", "that",
  // Common verbs
  "be", "is", "am", "are", "was", "were", "been", "being",
  "have", "has", "had", "having",
  "do", "does", "did", "doing", "done",
  "will", "would", "shall", "should", "may", "might", "must", "can", "could",
  "get", "gets", "got", "getting",
  "make", "makes", "made", "making",
  "go", "goes", "went", "going", "gone",
  "take", "takes", "took", "taking", "taken",
  "come", "comes", "came", "coming",
  "see", "sees", "saw", "seeing", "seen",
  "know", "knows", "knew", "knowing", "known",
  "give", "gives", "gave", "giving", "given",
  "use", "uses", "used", "using",
  "find", "finds", "found", "finding",
  "tell", "tells", "told", "telling",
  "say", "says", "said", "saying",
  "need", "needs", "needed", "needing",
  "want", "wants", "wanted", "wanting",
  "try", "tries", "tried", "trying",
  "let", "lets", "letting",
  "put", "puts", "putting",
  "keep", "keeps", "kept", "keeping",
  "set", "sets", "setting",
  "show", "shows", "showed", "showing", "shown",
  // Adverbs & adjectives
  "very", "really", "just", "also", "too", "only", "even", "still",
  "already", "always", "never", "ever", "often", "sometimes", "usually",
  "now", "then", "here", "there", "where", "when", "how", "why",
  "again", "once", "twice", "first", "last", "next", "new", "old",
  "good", "bad", "great", "little", "big", "small", "large", "long", "short",
  "high", "low", "much", "many", "few", "more", "most", "less", "least",
  "all", "each", "every", "both", "either", "neither", "any", "some", "no",
  "other", "another", "same", "different", "such", "own",
  // Question words
  "if", "whether", "else",
  // Common nouns (too generic)
  "thing", "things", "way", "ways", "time", "times", "day", "days",
  "year", "years", "people", "person", "part", "parts", "place", "places",
  "case", "cases", "point", "points", "fact", "facts", "end", "ends",
  "example", "examples", "result", "results", "reason", "reasons",
  // Programming/technical noise
  "true", "false", "null", "undefined", "none", "empty",
  "value", "values", "data", "info", "information",
  "type", "types", "string", "strings", "number", "numbers",
  "boolean", "object", "objects", "array", "arrays", "list", "lists",
  "function", "functions", "method", "methods", "class", "classes",
  "property", "properties", "parameter", "parameters", "argument", "arguments",
  "option", "options", "config", "configuration", "setting", "settings",
  "name", "names", "id", "ids", "key", "keys", "index", "indices",
  "input", "inputs", "output", "outputs", "request", "requests", "response", "responses",
  "error", "errors", "message", "messages", "text", "content", "contents",
  "file", "files", "path", "paths", "url", "urls", "uri", "uris",
  "default", "defaults", "current", "previous", "next",
  // Action words that are too common
  "start", "stop", "run", "execute", "call", "return", "returns",
  "add", "remove", "delete", "update", "change", "modify",
  "read", "write", "load", "save", "send", "receive",
  "open", "close", "create", "destroy", "init", "initialize",
  "enable", "disable", "active", "inactive",
  // Units and measurements (without context)
  "per", "rate", "count", "total", "average", "max", "min", "sum",
]);

/**
 * Check if a word is noise that shouldn't be in the dictionary.
 */
function isNoiseWord(word: string): boolean {
  const lower = word.toLowerCase();

  // In noise word list
  if (NOISE_WORDS.has(lower)) return true;

  // Too short (less than 3 chars)
  if (lower.length < 3) return true;

  // Pure numbers or numbers with units
  if (/^\d+(\.\d+)?(%|px|em|rem|pt|km|m|s|ms)?$/i.test(lower)) return true;

  // Hex colors or codes
  if (/^[0-9a-f]{6,}$/i.test(lower)) return true;
  if (/^#[0-9a-f]+$/i.test(lower)) return true;

  // Version numbers
  if (/^v?\d+(\.\d+)+$/i.test(lower)) return true;

  // Single repeated characters
  if (/^(.)\1+$/.test(lower)) return true;

  // Common file extensions used alone
  if (/^(js|ts|json|xml|html|css|md|txt|png|jpg|gif|svg)$/i.test(lower)) return true;

  return false;
}

/**
 * Extract clean words from text.
 * Filters noise, requires minimum length.
 */
function extractWords(text: string, minLength = 3): string[] {
  return text
    .split(/[\s_\-:,./()[\]{}'"]+/)
    .map((w) => w.toLowerCase().trim().replace(/[^a-z0-9]/g, ""))
    .filter((w) => w.length >= minLength && !isNoiseWord(w));
}

/**
 * Create a dictionary entry.
 */
function createEntry(
  term: string,
  source: DictionaryEntry["source"],
  weight: number
): DictionaryEntry {
  return { term, source, weight };
}

// === Public API ===

/**
 * Build dictionary entries from raw tool catalog text.
 */
export function buildFromToolCatalog(
  toolTexts: Array<{
    name: string;
    description?: string;
    paramNames?: string[];
    enumValues?: string[];
  }>
): DictionaryEntry[] {
  const entries: DictionaryEntry[] = [];
  const seen = new Set<string>();

  for (const tool of toolTexts) {
    // Tool name (highest priority)
    const nameLower = tool.name.toLowerCase();
    if (!seen.has(nameLower)) {
      entries.push(createEntry(tool.name, "tool", 1));
      seen.add(nameLower);
    }

    // Words from tool name
    for (const word of extractWords(tool.name)) {
      if (!seen.has(word)) {
        entries.push(createEntry(word, "tool", 0.85));
        seen.add(word);
      }
    }

    // Words from description (longer words only)
    if (tool.description) {
      for (const word of extractWords(tool.description, 4)) {
        if (!seen.has(word)) {
          entries.push(createEntry(word, "tool", 0.6));
          seen.add(word);
        }
      }
    }

    // Parameter names
    for (const param of tool.paramNames ?? []) {
      const paramLower = param.toLowerCase();
      if (!seen.has(paramLower)) {
        entries.push(createEntry(param, "tool", 0.7));
        seen.add(paramLower);
      }
    }

    // Enum values
    for (const enumVal of tool.enumValues ?? []) {
      const enumLower = enumVal.toLowerCase();
      if (!seen.has(enumLower)) {
        entries.push(createEntry(enumVal, "tool", 0.75));
        seen.add(enumLower);
      }
    }
  }

  return entries;
}

/**
 * Build dictionary entries from raw status text.
 */
export function buildFromStatusText(statusText: string): DictionaryEntry[] {
  if (!statusText) return [];

  const entries: DictionaryEntry[] = [];
  const seen = new Set<string>();

  // Split on common delimiters
  const tokens = statusText
    .split(/[\n:,|=]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && t.length <= 30);

  for (const token of tokens) {
    // Skip noise
    if (isNoiseWord(token)) continue;

    const lower = token.toLowerCase();
    if (!seen.has(lower)) {
      entries.push(createEntry(token, "status", 0.7));
      seen.add(lower);
    }
  }

  return entries;
}

/**
 * Combine multiple dictionary sources, deduplicating by term.
 */
export function combineDictionaries(
  ...dictionaries: DictionaryEntry[][]
): DictionaryEntry[] {
  const seen = new Set<string>();
  const combined: DictionaryEntry[] = [];

  for (const dict of dictionaries) {
    for (const entry of dict) {
      const key = entry.term.toLowerCase();
      if (!seen.has(key)) {
        combined.push(entry);
        seen.add(key);
      }
    }
  }

  return combined;
}
