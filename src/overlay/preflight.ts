import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { AgentPrompts, PreflightResult } from "../types.js";
import type { Logger } from "../ui/logger.js";
import type { OllamaClient } from "../core/ollama.js";
import type { InventoryEntry } from "../utils/tools.js";
import type { PipelineContext, PipelineDeps, PipelineStep } from "../core/pipeline.js";
import { extractAssistantText } from "../utils/strings.js";
import { getCommonToolNames } from "../utils/tools.js";
import { fetchStatusInfo, type ResourceReaderDeps } from "../mcp/resources.js";
import { createStep } from "../core/pipeline.js";

export interface PreflightDeps extends ResourceReaderDeps {
  ollamaClient: OllamaClient;
  agentLog: Logger;
}

export async function runPreflightCheck(
  userRequest: string,
  previousAssistantResponse: string,
  toolInventory: InventoryEntry[],
  client: Client,
  agentPrompts: AgentPrompts,
  deps: PreflightDeps
): Promise<PreflightResult> {
  let expandedRequest = userRequest;

  deps.agentLog("[agent] Running preflight expansion...");

  const commonToolNames = getCommonToolNames(toolInventory);

  const { statusInfo } = await fetchStatusInfo(client, deps, "Preflight ");
  const statusSection = statusInfo ? `\nSTATUS:\n${statusInfo}\n` : "";

  const preflightSystem = `${agentPrompts.roleForAssistant}

TOOLS: ${commonToolNames}
${statusSection}
CONTEXT (for reference only):
${previousAssistantResponse}

TASK: Rewrite the user input as a complete, self-contained natural language request.
- If the input references the context (e.g., "yes", "do it", "the first one"), incorporate the relevant details.
- If the input is already complete, return it unchanged.
- Replace invalid names with valid names from TOOLS or STATUS. User STT may mangle proper nouns.
- NEVER return the CONTEXT itself.
- NEVER return function calls or code - only plain English.

OUTPUT: Return ONLY the rewritten request as a plain English sentence.`;

  const response = await deps.ollamaClient.call(
    [
      { role: "system", content: preflightSystem },
      { role: "user", content: userRequest },
    ],
    [],
    { options: { temperature: 0.3 }, spinnerMessage: "Preflight: expand" }
  );

  const expanded = extractAssistantText(response.message).trim();
  deps.agentLog(`[agent] Preflight raw response: ${JSON.stringify(response.message)}`);
  deps.agentLog(`[agent] Preflight extracted: "${expanded}"`);

  if (expanded && expanded.length > 0 && expanded !== userRequest) {
    deps.agentLog(`[agent] Preflight expanded: "${expanded}"`);
    expandedRequest = expanded;
  }

  return { expandedRequest };
}

// --- Pipeline Step ---

export const step: PipelineStep = createStep(
  "preflight",
  async (ctx: PipelineContext, deps: PipelineDeps): Promise<void> => {
    const result = await runPreflightCheck(
      ctx.userInput,
      ctx.previousResponse,
      ctx.toolInventory,
      deps.client,
      ctx.agentPrompts,
      {
        ollamaClient: deps.ollamaClient,
        agentLog: deps.agentLog,
        agentWarn: deps.agentWarn,
      }
    );
    ctx.expandedRequest = result.expandedRequest;
  }
)
