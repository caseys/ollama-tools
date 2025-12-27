import type { Config, OllamaMessage, PlanResult, AgentPrompts, ParsedToolsResult } from "../types.js";
import type { Logger } from "../ui/logger.js";
import type { OllamaClient } from "../core/ollama.js";
import type { InventoryEntry } from "../utils/tools.js";
import type { PipelineContext, PipelineDeps, PipelineStep } from "../core/pipeline.js";
import { MAX_SEQUENTIAL_PLAN_LENGTH } from "../config/constants.js";
import { blankLine } from "../ui/output.js";
import { extractAssistantText } from "../utils/strings.js";
import { describeError } from "../ui/logger.js";
import { findToolEntry, findToolMatch, getCommonTools, getOtherTools, formatToolsByTier } from "../utils/tools.js";
import { summarizeHistory } from "../utils/history.js";
import { createStep, retryOnEmpty, runWithConsensus } from "../core/pipeline.js";

// --- Parser ---

function parsePlannedToolsResponse(
  text: string | undefined | null,
  toolInventory: InventoryEntry[]
): ParsedToolsResult {
  if (!text || !text.trim()) {
    return { type: "empty" };
  }

  const availableNames = toolInventory.map((e) => e.openAi.function.name);
  const lowerNameMap = new Map(
    availableNames.map((name) => [name.toLowerCase(), name])
  );

  const jsonMatch = text.match(/\[[\s\S]*?\]/);
  if (!jsonMatch) {
    throw new Error(`Expected JSON array, got: ${text.slice(0, 100)}`);
  }

  const parsed: unknown = JSON.parse(jsonMatch[0]);
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected array, got: ${typeof parsed}`);
  }

  if (parsed.length === 0) {
    return { type: "empty" };
  }

  const tools: string[] = [];
  for (const item of parsed) {
    const match = findToolMatch(String(item).trim(), lowerNameMap);
    if (match && !tools.includes(match)) {
      tools.push(match);
    }
  }

  return tools.length > 0 ? { type: "tools", tools } : { type: "empty" };
}

// --- Consensus Helpers ---

function hasOrderDisagreement(
  toolResults: string[][],
  consensusTools: string[]
): boolean {
  if (consensusTools.length < 2) return false;

  const orders = toolResults
    .map((tools) => tools.filter((t) => consensusTools.includes(t)))
    .filter((filtered) => filtered.length === consensusTools.length);

  if (orders.length < 2) return false;

  const firstOrder = orders[0]!.join(",");
  return orders.some((order) => order.join(",") !== firstOrder);
}

/**
 * Compare two ParsedToolsResult for consensus.
 * Returns true if they have overlapping tools.
 */
function toolResultsMatch(a: ParsedToolsResult, b: ParsedToolsResult): boolean {
  if (a.type !== "tools" || b.type !== "tools") return false;
  if (!a.tools?.length || !b.tools?.length) return false;
  return a.tools.some((tool) => b.tools!.includes(tool));
}

// --- Planning ---

export interface PlanningDeps {
  config: Config;
  ollamaClient: OllamaClient;
  agentLog: Logger;
  agentWarn: Logger;
  toLLMLog: Logger;
}

const PLANNING_TEMPERATURES = [0.5, 0.8, 1.1];

async function runPlanningQuery(
  planningMessages: OllamaMessage[],
  toolInventory: InventoryEntry[],
  temperature: number,
  deps: PlanningDeps
): Promise<ParsedToolsResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => { controller.abort(); }, 30_000);

  try {
    const response = await deps.ollamaClient.callWithSignal(
      planningMessages,
      [],
      controller.signal,
      {
        options: { temperature },
        silent: true,
        spinnerMessage: "Planning: tools",
      }
    );
    clearTimeout(timeoutId);

    const planText = extractAssistantText(response.message).trim();
    if (!planText) {
      deps.agentLog(`[agent] Planning raw response was empty. Full message: ${JSON.stringify(response.message)}`);
    } else {
      deps.agentLog(`[agent] Planning raw (temp=${temperature}): "${planText.slice(0, 100)}${planText.length > 100 ? "..." : ""}"`);
    }
    const parsed = parsePlannedToolsResponse(planText, toolInventory);
    deps.agentLog(`[agent] Parsed result: type=${parsed.type}, tools=${parsed.tools?.join(",") ?? "none"}`);
    return parsed;
  } catch (error) {
    clearTimeout(timeoutId);
    deps.agentWarn(`[agent] Planning query failed (temp=${temperature}): ${error instanceof Error ? error.message : String(error)}`);
    return { type: "empty" };
  }
}

async function runOrderingQuery(
  consensusTools: string[],
  userPrompt: string,
  toolInventory: InventoryEntry[],
  agentPrompts: AgentPrompts,
  deps: PlanningDeps
): Promise<string[]> {
  const toolDescriptions = consensusTools
    .map((name) => {
      const entry = findToolEntry(toolInventory, name);
      const desc = entry?.openAi.function.description ?? "No description";
      return `- ${name}: ${desc}`;
    })
    .join("\n");

  const orderingSystem = `${agentPrompts.roleForAssistant}

TASK: Order these tools to fulfill the user's request.

TOOLS TO ORDER:
${toolDescriptions}

OUTPUT: Return tool names as a JSON array in execution order, e.g. ["first_tool", "second_tool"]`;

  deps.agentLog("[agent] Running ordering query to resolve order disagreement...");

  const response = await deps.ollamaClient.call(
    [
      { role: "system", content: orderingSystem },
      { role: "user", content: userPrompt },
    ],
    [],
    { options: { temperature: 0.3 }, spinnerMessage: "Planning: order" }
  );

  const text = extractAssistantText(response.message).trim();
  const parsed = parsePlannedToolsResponse(text, toolInventory);

  if (parsed.type === "tools" && parsed.tools && parsed.tools.length > 0) {
    const orderedTools = parsed.tools.filter((t) => consensusTools.includes(t));
    if (orderedTools.length === consensusTools.length) {
      return orderedTools;
    }
  }

  deps.agentLog("[agent] Ordering query did not resolve; using original order.");
  return consensusTools;
}

function buildPlanningMessages(
  userPrompt: string,
  toolInventory: InventoryEntry[],
  historySummary: string,
  agentPrompts: AgentPrompts,
  promptGuidance = "",
  statusInfo = ""
): OllamaMessage[] {
  const historySection = historySummary || "This is the initial prompt.";
  const toolsText = formatToolsByTier(toolInventory);

  const statusSection = statusInfo ? `\n\nSTATUS:\n${statusInfo}` : "";
  const guidanceSection = promptGuidance
    ? `\n\nWORKFLOW GUIDANCE:\n${promptGuidance}`
    : "";

  const combinedPlanningPrompt = `${agentPrompts.roleForAssistant}

TASK: Select tools from TOOLS to fulfill the user request.

RULES:
1. Map user intent to tools (e.g., "go to X" → transfer tools, "fix orbit" → circularize).
2. Replace invalid tool names with valid names from TOOLS to fix speech-to-text errors. NO invented names.
3. Pick the smallest set of tools needed - since tools can be applied but not removed.
4. Return tools in execution order. using clues from user, tool descriptions, and your role experience.
5. Return false if no tool request is found.
6. Do not repeat tools from HISTORY for the same purpose.

OUTPUT: Return a JSON array of tool names, e.g. ["tool_name"] or ["first_tool", "second_tool"]`;

  return [
    {
      role: "system",
      content: `${combinedPlanningPrompt}\n\nTOOLS:\n${toolsText}${statusSection}\n\nHISTORY:\n${historySection}${guidanceSection}`,
    },
    {
      role: "user",
      content: userPrompt,
    },
  ];
}

export async function planToolSequence(
  userPrompt: string,
  toolInventory: InventoryEntry[],
  historySummary: string,
  agentPrompts: AgentPrompts,
  deps: PlanningDeps,
  promptGuidance = "",
  statusInfo = ""
): Promise<PlanResult> {
  deps.agentLog("[agent] Planning tool sequence (consensus + retry mode)...");

  if (!userPrompt.trim()) {
    return { sequence: [] };
  }

  const commonTools = getCommonTools(toolInventory);
  const otherTools = getOtherTools(toolInventory);
  deps.agentLog(
    `[agent] Tools: ${commonTools.length} common, ${otherTools.length} other`
  );
  if (commonTools.length > 0) {
    deps.agentLog(`[agent] Common tool names: ${commonTools.map(t => t.openAi.function.name).slice(0, 5).join(", ")}${commonTools.length > 5 ? "..." : ""}`);
  }

  const planningMessages = buildPlanningMessages(
    userPrompt,
    toolInventory,
    historySummary,
    agentPrompts,
    promptGuidance,
    statusInfo
  );

  deps.toLLMLog("[toLLM] ─── Planning Prompt ───");
  for (const message of planningMessages) {
    if (message.role === "system") {
      deps.toLLMLog("[system]");
    }
    deps.toLLMLog(message.content);
    blankLine(deps.config.debug);
  }

  try {
    deps.agentLog("[agent] Running consensus planning with retry on empty...");

    // Run consensus with early exit, each query wrapped in retryOnEmpty
    const consensusResult = await runWithConsensus<ParsedToolsResult>(
      async (temperature) => {
        const { result, attempts } = await retryOnEmpty(
          () => runPlanningQuery(planningMessages, toolInventory, temperature, deps),
          (r) => r === null || r.type === "empty",
          {
            maxAttempts: 3,
            onRetry: (attempt) => { deps.agentLog(`[agent] Query retry ${attempt} (temp=${temperature})`); },
          }
        );
        if (attempts > 1) {
          deps.agentLog(`[agent] Query (temp=${temperature}) succeeded after ${attempts} attempts`);
        }
        return result;
      },
      toolResultsMatch,
      {
        maxQueries: PLANNING_TEMPERATURES.length,
        minMatches: 2,
        matchMode: "some",
        temperatures: PLANNING_TEMPERATURES,
      }
    );

    // Log results
    for (const [index, r] of consensusResult.allResults.entries()) {
      const toolsText =
        r.type === "tools" && r.tools && r.tools.length > 0
          ? r.tools.join(", ")
          : `(${r.type})`;
      deps.agentLog(
        `[agent] Query ${index + 1}: ${toolsText}`
      );
    }

    deps.agentLog(
      `[agent] Consensus: ${consensusResult.matchCount} matches from ${consensusResult.queriesRun} queries`
    );

    // Extract tools from consensus result
    let consensusTools: string[] = [];
    if (consensusResult.result?.type === "tools" && consensusResult.result.tools) {
      consensusTools = consensusResult.result.tools;
    }

    // Check for order disagreement among results with tools
    const toolResults = consensusResult.allResults
      .filter((r): r is ParsedToolsResult & { tools: string[] } =>
        r.type === "tools" && r.tools !== undefined && r.tools.length > 0
      )
      .map((r) => r.tools);

    if (hasOrderDisagreement(toolResults, consensusTools) && consensusTools.length >= 2) {
      const orderedTools = await runOrderingQuery(
        consensusTools,
        userPrompt,
        toolInventory,
        agentPrompts,
        deps
      );
      deps.agentLog(`[agent] Ordered tools: ${orderedTools.join(" -> ")}`);
      consensusTools = orderedTools;
    }

    deps.agentLog(`[agent] Consensus tools: ${consensusTools.join(", ") || "(none)"}`);

    const seen = new Set<string>();
    const validSequence = consensusTools.filter((name) => {
      if (seen.has(name)) return false;
      if (!findToolEntry(toolInventory, name)) return false;
      seen.add(name);
      return true;
    });

    if (validSequence.length > MAX_SEQUENTIAL_PLAN_LENGTH) {
      deps.agentWarn(
        `[agent] Planning returned ${validSequence.length} tools (exceeds limit of ${MAX_SEQUENTIAL_PLAN_LENGTH}).`
      );
      return { sequence: [] };
    }

    if (validSequence.length > 0) {
      deps.agentLog(`[agent] Planned tool order: ${validSequence.join(" -> ")}`);
    } else {
      deps.agentLog("[agent] Planning step returned no tools.");
    }

    return { sequence: validSequence };
  } catch (error) {
    deps.agentWarn(`[agent] Planning step failed: ${describeError(error)}`);
    return { sequence: [] };
  }
}

// --- Pipeline Step ---

export const step: PipelineStep = createStep(
  "plan",
  async (ctx: PipelineContext, deps: PipelineDeps): Promise<void> => {
    const historySummary = summarizeHistory(ctx.history, 5);
    const result = await planToolSequence(
      ctx.expandedRequest ?? ctx.userInput,
      ctx.toolInventory,
      historySummary,
      ctx.agentPrompts,
      {
        config: deps.config,
        ollamaClient: deps.ollamaClient,
        agentLog: deps.agentLog,
        agentWarn: deps.agentWarn,
        toLLMLog: deps.toLLMLog,
      },
      "",
      ctx.statusInfo ?? ""
    );
    ctx.plannedTools = result.sequence;
    ctx.branch = result.sequence.length > 0 ? "execute" : "clarify";
  }
)
