import type { PipelineContext, PipelineDeps, PipelineStep } from "../core/pipeline.js";
import { extractAssistantText } from "../utils/strings.js";
import { createStep } from "../core/pipeline.js";

export interface SummaryToolEvent {
  name: string;
  success: boolean;
  summary: string;
}

function formatToolResults(toolEvents: SummaryToolEvent[]): string {
  return toolEvents
    .map((e, i) => `${i + 1}. ${e.name} ${e.success ? "✓" : "✗"}: ${e.summary}`)
    .join("\n");
}

// --- Pipeline Step ---

export const step: PipelineStep = createStep(
  "summary",
  async (ctx: PipelineContext, deps: PipelineDeps): Promise<void> => {
    // If reflection asked a question, use that directly
    if (ctx.reflectionQuestion) {
      ctx.response = ctx.reflectionQuestion;
      ctx.stateSummary = "Awaiting user input.";
      return;
    }

    const toolEvents = (ctx.toolResults ?? []).map((e) => ({
      name: e.tool,
      success: e.status === "success",
      summary: e.result,
    }));

    const resultsText = formatToolResults(toolEvents);

    // Include stop reason if reflection stopped execution
    const stopContext = ctx.reflectionStopped
      ? `\n\nSTOPPED: ${ctx.reflectionStopped.reason}`
      : "";

    // Generate user-facing response
    const responsePrompt = `${ctx.agentPrompts.roleForAssistant}

USER REQUEST:
${ctx.userInput}

RESULTS:
${resultsText}${stopContext}

TASK: Provide a brief response (2 sentences max):
1. First sentence: summarize what was accomplished based on RESULTS only.${ctx.reflectionStopped ? " Explain why execution was stopped." : ""}
2. Second sentence: ${ctx.reflectionStopped ? "Suggest what the user might do to address the issue." : 'encourage the user to continue (e.g., "What would you like to do next?").'}
Do NOT suggest actions not shown in RESULTS. If a tool failed, report the error.`;

    const responseResult = await deps.ollamaClient.call(
      [{ role: "system", content: responsePrompt }],
      [],
      { spinnerMessage: "Summarizing" }
    );
    ctx.response = extractAssistantText(responseResult.message);

    // Generate concise state summary for history
    const statePrompt = `RESULTS:
${resultsText}${stopContext}

TASK: Write ONE sentence describing the state changes from these results.
Example: "File created at /path/to/file." or "Database updated with new record."
Do NOT include encouragement or next steps. Just the factual state change.`;

    const stateResult = await deps.ollamaClient.call(
      [{ role: "system", content: statePrompt }],
      [],
      { spinnerMessage: "Recording" }
    );
    ctx.stateSummary = extractAssistantText(stateResult.message);
  },
  (ctx: PipelineContext): boolean =>
    ctx.branch === "execute" && (ctx.toolResults?.length ?? 0) > 0
)
