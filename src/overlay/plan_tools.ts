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
import { createStep } from "../core/pipeline.js";

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

// --- Consensus ---

interface ConsensusResult {
  tools: string[];
  emptyCount: number;
  orderDisagreement: boolean;
}

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

function computeConsensusTools(
  results: ParsedToolsResult[],
  threshold = 3
): ConsensusResult {
  const emptyCount = results.filter((r) => r.type === "empty").length;

  const toolResults = results
    .filter(
      (r): r is ParsedToolsResult & { tools: string[] } =>
        r.type === "tools" && r.tools !== undefined && r.tools.length > 0
    )
    .map((r) => r.tools);

  if (toolResults.length === 0) {
    return { tools: [], emptyCount, orderDisagreement: false };
  }

  const counts = new Map<string, number>();
  for (const toolList of toolResults) {
    for (const tool of toolList) {
      counts.set(tool, (counts.get(tool) ?? 0) + 1);
    }
  }

  const effectiveThreshold = Math.min(threshold, toolResults.length);
  let consensusSet = [...counts.entries()]
    .filter(([, count]) => count >= effectiveThreshold)
    .map(([tool]) => tool);

  if (consensusSet.length === 0 && effectiveThreshold > 2) {
    consensusSet = [...counts.entries()]
      .filter(([, count]) => count >= 2)
      .map(([tool]) => tool);
  }

  let consensus: string[] = [];
  if (consensusSet.length > 0) {
    let bestResult: string[] = [];
    let bestOverlap = 0;
    for (const result of toolResults) {
      const overlap = result.filter((t) => consensusSet.includes(t)).length;
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestResult = result;
      }
    }
    consensus = bestResult.filter((t) => consensusSet.includes(t));
  }

  const orderDisagreement = hasOrderDisagreement(toolResults, consensus);

  return { tools: consensus, emptyCount, orderDisagreement };
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

Select tools from TOOLS to fulfill the user request.

RULES:
1. Map user intent to tools (e.g., "go to X" → transfer tools, "fix orbit" → circularize).
2. Pick the smallest set of tools needed.
3. Use exact tool names - NO invented names.
4. Return tools in execution order.
5. Return empty array ONLY for greetings or questions.
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
  deps.agentLog("[agent] Planning tool sequence (consensus mode)...");

  if (!userPrompt.trim()) {
    return { sequence: [], needsAltIntro: false };
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
    deps.agentLog(
      `[agent] Running ${PLANNING_TEMPERATURES.length} planning queries for consensus...`
    );

    const queryPromises = PLANNING_TEMPERATURES.map((temperature) =>
      runPlanningQuery(planningMessages, toolInventory, temperature, deps)
    );

    const results = await Promise.all(queryPromises);

    for (const [index, r] of results.entries()) {
      const toolsText =
        r.type === "tools" && r.tools && r.tools.length > 0
          ? r.tools.join(", ")
          : `(${r.type})`;
      deps.agentLog(
        `[agent] Query ${index + 1} (temp=${PLANNING_TEMPERATURES[index]}): ${toolsText}`
      );
    }

    const consensus = computeConsensusTools(results, PLANNING_TEMPERATURES.length);

    if (consensus.orderDisagreement && consensus.tools.length >= 2) {
      const orderedTools = await runOrderingQuery(
        consensus.tools,
        userPrompt,
        toolInventory,
        agentPrompts,
        deps
      );
      deps.agentLog(`[agent] Ordered tools: ${orderedTools.join(" -> ")}`);
      consensus.tools = orderedTools;
    }

    if (consensus.emptyCount >= 2) {
      deps.agentLog(
        "[agent] Planning consensus: no tools determined (2+ empty). Needs alt_intro."
      );
      return { sequence: [], needsAltIntro: true };
    }

    const sequence = consensus.tools;
    deps.agentLog(`[agent] Consensus tools: ${sequence.join(", ") || "(none)"}`);

    const seen = new Set<string>();
    const validSequence = sequence.filter((name) => {
      if (seen.has(name)) return false;
      if (!findToolEntry(toolInventory, name)) return false;
      seen.add(name);
      return true;
    });

    if (validSequence.length > MAX_SEQUENTIAL_PLAN_LENGTH) {
      deps.agentWarn(
        `[agent] Planning returned ${validSequence.length} tools (exceeds limit of ${MAX_SEQUENTIAL_PLAN_LENGTH}). Needs alt_intro.`
      );
      return { sequence: [], needsAltIntro: true };
    }

    if (validSequence.length > 0) {
      deps.agentLog(`[agent] Planned tool order: ${validSequence.join(" -> ")}`);
    } else {
      deps.agentLog("[agent] Planning step returned no tools.");
    }

    return {
      sequence: validSequence,
      needsAltIntro: validSequence.length === 0,
    };
  } catch (error) {
    deps.agentWarn(`[agent] Planning step failed: ${describeError(error)}`);
    return { sequence: [], needsAltIntro: true };
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
