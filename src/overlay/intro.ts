import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { AgentPrompts } from "../types.js";
import type { Logger } from "../ui/logger.js";
import type { OllamaClient } from "../core/ollama.js";
import type { InventoryEntry } from "../utils/tools.js";
import type { PipelineContext, PipelineDeps, PipelineStep } from "../core/pipeline.js";
import { HISTORY_MAX_PROMPTS } from "../config/constants.js";
import { truncateMiddle, extractAssistantText } from "../utils/strings.js";
import { getCommonToolNames } from "../utils/tools.js";
import { summarizeHistory, type HistoryEntry } from "../utils/history.js";
import { fetchStatusInfo, type ResourceReaderDeps } from "../mcp/resources.js";
import { createStep } from "../core/pipeline.js";

export interface AltIntroDeps extends ResourceReaderDeps {
  ollamaClient: OllamaClient;
  agentLog: Logger;
  toLLMLog: Logger;
}

export async function runAltIntroProcess(
  userPrompt: string,
  toolInventory: InventoryEntry[],
  history: HistoryEntry[],
  agentPrompts: AgentPrompts,
  client: Client,
  deps: AltIntroDeps
): Promise<string> {
  deps.agentLog("[agent] Running alt_intro process...");

  const { statusInfo } = await fetchStatusInfo(client, deps, "Alt-intro ");
  if (statusInfo) {
    deps.agentLog(`[agent] Status: ${truncateMiddle(statusInfo, 100)}`);
  }

  const historySummary = summarizeHistory(history, HISTORY_MAX_PROMPTS);
  const commonToolNames = getCommonToolNames(toolInventory);

  const altIntroPrompt = `${agentPrompts.roleForAssistant}

The planning stage could not determine which tools to use for this request.

TOOLS: ${commonToolNames}

CONTEXT:
${statusInfo ? `Current status: ${statusInfo}` : "No status available."}
${historySummary || "This is the initial prompt."}

USER REQUEST:
${userPrompt}

OUTPUT: Ask ONE short clarifying question to understand which tool(s) would help.`;

  deps.toLLMLog("[toLLM] ─── Alt-Intro Prompt ───");
  deps.toLLMLog(`[system] ${altIntroPrompt.split("\n").slice(0, 3).join(" ")}`);

  const response = await deps.ollamaClient.call(
    [
      { role: "system", content: altIntroPrompt },
      { role: "user", content: userPrompt },
    ],
    [],
    { spinnerMessage: "Clarifying" }
  );

  const answer = extractAssistantText(response.message);
  return answer;
}

// --- Pipeline Step ---

export const step: PipelineStep = createStep(
  "clarify",
  async (ctx: PipelineContext, deps: PipelineDeps): Promise<void> => {
    const response = await runAltIntroProcess(
      ctx.userInput,
      ctx.toolInventory,
      ctx.history,
      ctx.agentPrompts,
      deps.client,
      {
        ollamaClient: deps.ollamaClient,
        agentLog: deps.agentLog,
        agentWarn: deps.agentWarn,
        toLLMLog: deps.toLLMLog,
      }
    );
    ctx.response = response;
  },
  (ctx: PipelineContext): boolean => ctx.branch === "clarify"
)
