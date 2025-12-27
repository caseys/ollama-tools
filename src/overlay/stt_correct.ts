import type { Logger } from "../ui/logger.js";
import type { OllamaClient } from "../core/ollama.js";
import type { PipelineContext, PipelineDeps, PipelineStep } from "../core/pipeline.js";
import { getCommonToolNames } from "../utils/tools.js";
import { extractAssistantText } from "../utils/strings.js";
import { createStep } from "../core/pipeline.js";

export interface SttCorrectionDeps {
  ollamaClient: OllamaClient;
  agentLog: Logger;
}

export async function runSttCorrection(
  userQuery: string,
  toolNames: string,
  statusInfo: string,
  roleForAssistant: string,
  deps: SttCorrectionDeps
): Promise<string> {
  deps.agentLog("[agent] Running STT correction...");

  const systemPrompt = `${roleForAssistant}

TOOLS:
${toolNames}

STATUS:
${statusInfo}

TASK: Corret the speech-to-text errors user input, STT may mangle tool names and argument values:
- Replace invalid names/values with valid names from TOOLS or STATUS. 
- NEVER return function calls or code - only plain English.
- Make minimal changes. If the input is already complete, return it unchanged.

OUTPUT: Return ONLY the user request with corrections.`;

  const response = await deps.ollamaClient.call(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userQuery }
    ],
    [],
    { options: { /* temperature: 0.8 */ }, spinnerMessage: "Correcting Speech" }
  );

  return extractAssistantText(response.message).trim();
}

// --- Pipeline Step ---

export const step: PipelineStep = createStep(
  "stt_correct",
  async (ctx: PipelineContext, deps: PipelineDeps): Promise<void> => {
    const toolNames = getCommonToolNames(ctx.toolInventory);
    const corrected = await runSttCorrection(
      ctx.userInput,
      toolNames,
      ctx.statusInfo ?? "",
      ctx.agentPrompts.roleForAssistant,
      { ollamaClient: deps.ollamaClient, agentLog: deps.agentLog }
    );
    if (corrected && corrected !== ctx.userInput) {
      deps.agentLog(`[stt] Corrected: "${corrected}"`);
      ctx.userInput = corrected;
    }
  },
  (ctx: PipelineContext): boolean => ctx.inputSource === "voice"
);
