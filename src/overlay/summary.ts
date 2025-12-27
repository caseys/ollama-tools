import type { PipelineContext, PipelineDeps, PipelineStep } from "../core/pipeline.js";
import { extractAssistantText } from "../utils/strings.js";
import { createStep } from "../core/pipeline.js";

export interface SummaryToolEvent {
  name: string;
  success: boolean;
  summary: string;
}

export function buildSummaryPrompt(
  userQuery: string,
  toolEvents: SummaryToolEvent[]
): string {
  const lines: string[] = ["USER REQUEST:", userQuery, "", "RESULTS:"];

  for (const [index, event] of toolEvents.entries()) {
    const status = event.success ? "✓" : "✗";
    lines.push(`${index + 1}. ${event.name} ${status}: ${event.summary}`);
  }

  lines.push(
    "",
    "INSTRUCTIONS:",
    "1. Summarize ONLY what the RESULTS show was accomplished.",
    "2. Do NOT suggest actions or next steps not shown in RESULTS.",
    "3. If a tool failed, report the error.",
    "4. Ask what the user wants to do next.",
    "",
    "Keep response under 50 words."
  );

  return lines.join("\n");
}

// --- Pipeline Step ---

export const step: PipelineStep = createStep(
  "summary",
  async (ctx: PipelineContext, deps: PipelineDeps): Promise<void> => {
    const toolEvents = (ctx.toolResults ?? []).map((e) => ({
      name: e.tool,
      success: e.status === "success",
      summary: e.result,
    }));

    const summaryPrompt = buildSummaryPrompt(ctx.userInput, toolEvents);
    const summarySystemPrompt = `${ctx.agentPrompts.roleForAssistant}\n\nSummarize what was accomplished based on the tool results.\n\n${summaryPrompt}`;

    const response = await deps.ollamaClient.call(
      [{ role: "system", content: summarySystemPrompt }],
      [],
      { spinnerMessage: "Finalizing" }
    );

    ctx.response = extractAssistantText(response.message);
  },
  (ctx: PipelineContext): boolean =>
    ctx.branch === "execute" && (ctx.toolResults?.length ?? 0) > 0
)
