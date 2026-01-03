/**
 * STT (Speech-to-Text) pre-processing module.
 *
 * Provides phonetic matching for STT correction using known terms
 * from tool catalog and status resource.
 *
 * Fully abstract - no domain-specific hardcoding.
 */

export { preprocessSttInput, type PreprocessResult } from "./preprocessor.js";
export {
  buildFromToolCatalog,
  buildFromStatusText,
  combineDictionaries,
  type DictionaryEntry,
} from "./dictionary.js";
