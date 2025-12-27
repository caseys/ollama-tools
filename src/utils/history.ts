import {
  HISTORY_PROMPT_TEXT_LIMIT,
  HISTORY_RESULT_TEXT_LIMIT,
} from "../config/constants.js";
import { truncateMiddle } from "./strings.js";

export interface HistoryToolEvent {
  name: string;
  success: boolean;
}

export interface HistoryEntry {
  prompt: string;
  toolEvents?: HistoryToolEvent[];
  finalSummary?: string;
}

export function summarizeHistory(history: HistoryEntry[], limit: number): string {
  if (history.length === 0) {
    return "";
  }
  const toShow = history.slice(-limit);
  const truncated = history.length - toShow.length;
  const lines: string[] = [];
  const header =
    truncated > 0
      ? `History: last ${toShow.length}/${history.length} (older ${truncated} hidden)`
      : `History: last ${toShow.length}`;
  lines.push(header);

  for (const [index, entry] of toShow.entries()) {
    const absoluteIndex = history.length - toShow.length + index + 1;
    lines.push(
      `${absoluteIndex}. ${truncateMiddle(entry.prompt, HISTORY_PROMPT_TEXT_LIMIT)}`
    );
    const toolText = entry.toolEvents?.length
      ? entry.toolEvents
          .map((event) => `${event.name}${event.success ? "✅" : "❌"}`)
          .join("; ")
      : "none";
    lines.push(`   tools: ${toolText}`);
    const finalSummary = truncateMiddle(
      entry.finalSummary,
      HISTORY_RESULT_TEXT_LIMIT
    );
    if (finalSummary && finalSummary.length > 0) {
      lines.push(`   result: ${finalSummary}`);
    }
  }
  return lines.join("\n");
}
