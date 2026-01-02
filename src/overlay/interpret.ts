/**
 * Interpret step: processes user input at turn start.
 *
 * Runs ONCE at the beginning of each turn, before SELECT_TOOL.
 * Responsibilities:
 * 1. Fix speech-to-text errors using TOOL names and STATUS context
 * 2. Combine with previous interpreted requests (if history exists)
 * 3. Route: proceed to tools, respond directly, or ask for clarification
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Config, OllamaMessage, AgentPrompts } from "../types.js";
import type { Logger } from "../ui/logger.js";
import type { Spinner } from "../ui/spinner.js";
import type { OllamaClient } from "../core/ollama.js";
import type { InventoryEntry } from "../utils/tools.js";
import type { TurnInput, TurnWorkingState } from "../core/turn-types.js";
import { fetchStatusInfo } from "../mcp/resources.js";
import { runWithConsensus } from "../core/consensus.js";
import type { SamplingParams } from "../core/retry.js";

// === Helpers ===

function formatToolNames(toolInventory: InventoryEntry[]): string {
  // Sort by tier (lower = more important), defaulting to tier 2 if undefined
  const sorted = [...toolInventory].sort((a, b) => {
    const tierA = a.tier ?? 2;
    const tierB = b.tier ?? 2;
    return tierA - tierB;
  });
  return sorted.map((t) => t.openAi.function.name).join(", ");
}

/**
 * Check if text exactly matches a tool name (case-insensitive).
 * Returns the canonical tool name if matched, undefined otherwise.
 */
function findExactToolMatch(text: string, toolInventory: InventoryEntry[]): string | undefined {
  const lower = text.toLowerCase().trim();
  for (const entry of toolInventory) {
    if (entry.openAi.function.name.toLowerCase() === lower) {
      return entry.openAi.function.name;
    }
  }
  return undefined;
}

// === Dependencies ===

export interface InterpretDeps {
  config: Config;
  client: Client;
  ollamaClient: OllamaClient;
  toolInventory: InventoryEntry[];
  agentPrompts: AgentPrompts;
  spinner: Spinner;
  agentLog: Logger;
  agentWarn: Logger;
  toLLMLog: Logger;
}

// === Result Types ===

export type InterpretResult =
  | { action: "proceed"; interpretedQuery: string }
  | { action: "execute"; tool: string; interpretedQuery: string }  // Direct tool match shortcut
  | { action: "respond"; response: string }
  | { action: "ask"; question: string };

// === Prompt Builders ===

function buildRewritePrompt(
  userInput: string,
  toolInventory: InventoryEntry[],
  agentPrompts: AgentPrompts,
  statusInfo: string
): OllamaMessage[] {
  const toolNames = formatToolNames(toolInventory);

  const system = `${agentPrompts.roleForAssistant}

TOOLS: ${toolNames}

STATUS:
${statusInfo || "No status available."}

TASK: Rewrite the user's request exactly as intended, fixing speech-to-text errors.

RULES:
1. Replace similar-sounding words with TOOL names or STATUS elements that make sense in context
2. Keep the request sentence structure intact - only fix misheard words
3. If nothing needs fixing, return the request unchanged
4. Examples: "author eyes" → "authorize", "cube or net ease" → "Kubernetes", "get hub" → "GitHub

Return ONLY the corrected request, no explanation or commentary.`;

  return [{ role: "system", content: system }, { role: "user", content: userInput }];
}

function buildCombinePrompt(
  correctedQuery: string,
  interpretHistory: string[]
): OllamaMessage[] {
  const historyFormatted = interpretHistory
    .map((h, i) => `${i + 1}. ${h}`)
    .join("\n");

  const system = `TASK: Combine the latest user request with previous context into one complete request.

Write a complete new request that represents the full user intent, combining relevant context from previous requests.
Return ONLY the combined request, no explanation.`;

  const user = `PREVIOUS INTERPRETED REQUESTS:
${historyFormatted}

LATEST REQUEST:
${correctedQuery}`;

  return [{ role: "system", content: system }, { role: "user", content: user }];
}

function buildRoutePrompt(
  finalQuery: string,
  toolInventory: InventoryEntry[],
  agentPrompts: AgentPrompts,
  statusInfo: string
): OllamaMessage[] {
  const toolNames = formatToolNames(toolInventory);

  const system = `${agentPrompts.roleForAssistant}

TOOLS: ${toolNames}

STATUS:
${statusInfo || "No status available."}

TASK: Can this request be satisfied by calling one or more TOOLS?

Reply with exactly ONE of these formats:
- TOOLS - The request requires tool calls (use this for actions, commands, operations)
- RESPOND: [your response here] - Answer the user directly without tools (use for questions about status, greetings, simple info)
- ASK: [your question here] - Need clarification to proceed (use when request is ambiguous or incomplete)

Reply with just the keyword and content, nothing else.`;

  return [{ role: "system", content: system }, { role: "user", content: finalQuery }];
}

// === Query Execution ===

async function runRewriteQuery(
  messages: OllamaMessage[],
  deps: InterpretDeps
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => { controller.abort(); }, 30_000);

  try {
    const response = await deps.ollamaClient.callWithSignal(
      messages,
      [],
      controller.signal,
      {
        options: { temperature: 0.3 },
        silent: true,
        spinnerMessage: "Interpreting",
      }
    );
    clearTimeout(timeoutId);

    const text = response.message?.content?.trim() ?? "";
    deps.agentLog(`[interpret] Rewritten: "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}"`);
    return text;
  } catch (error) {
    clearTimeout(timeoutId);
    deps.agentWarn(`[interpret] Rewrite failed: ${error instanceof Error ? error.message : String(error)}`);
    // Return original input on failure
    return messages[0]?.content ?? "";
  }
}

async function runCombineQuery(
  messages: OllamaMessage[],
  deps: InterpretDeps
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => { controller.abort(); }, 30_000);

  try {
    const response = await deps.ollamaClient.callWithSignal(
      messages,
      [],
      controller.signal,
      {
        options: { temperature: 0.3 },
        silent: true,
        spinnerMessage: "Combining context",
      }
    );
    clearTimeout(timeoutId);

    const text = response.message?.content?.trim() ?? "";
    deps.agentLog(`[interpret] Combined: "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}"`);
    return text;
  } catch (error) {
    clearTimeout(timeoutId);
    deps.agentWarn(`[interpret] Combine failed: ${error instanceof Error ? error.message : String(error)}`);
    // Return empty to use corrected query only
    return "";
  }
}

type RouteDecision = "tools" | { type: "respond"; content: string } | { type: "ask"; content: string };

function parseRouteResponse(raw: string): RouteDecision {
  const trimmed = raw.trim();
  const upper = trimmed.toUpperCase();

  // Check for TOOLS
  if (upper === "TOOLS" || upper.startsWith("TOOLS")) {
    return "tools";
  }

  // Check for RESPOND:
  if (upper.startsWith("RESPOND:")) {
    const content = trimmed.slice("RESPOND:".length).trim();
    return { type: "respond", content: content || "I understand." };
  }

  // Check for ASK:
  if (upper.startsWith("ASK:")) {
    const content = trimmed.slice("ASK:".length).trim();
    return { type: "ask", content: content || "Could you clarify your request?" };
  }

  // Default to tools for ambiguous responses (safer to try tools)
  return "tools";
}

async function runRouteQuery(
  messages: OllamaMessage[],
  params: SamplingParams,
  deps: InterpretDeps
): Promise<RouteDecision> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => { controller.abort(); }, 30_000);

  try {
    const response = await deps.ollamaClient.callWithSignal(
      messages,
      [],
      controller.signal,
      {
        options: {
          temperature: params.temperature,
          top_p: params.top_p,
          top_k: params.top_k,
        },
        silent: true,
        spinnerMessage: "Routing",
      }
    );
    clearTimeout(timeoutId);

    const raw = response.message?.content?.trim() ?? "";
    deps.agentLog(`[interpret] Route query (temp=${params.temperature}): "${raw.slice(0, 80)}"`);
    return parseRouteResponse(raw);
  } catch (error) {
    clearTimeout(timeoutId);
    deps.agentWarn(`[interpret] Route query failed (temp=${params.temperature}): ${error instanceof Error ? error.message : String(error)}`);
    // Default to tools on error
    return "tools";
  }
}

function routeDecisionsMatch(a: RouteDecision, b: RouteDecision): boolean {
  // Simple: both are "tools" or both are objects with same type
  if (a === "tools" && b === "tools") return true;
  if (typeof a === "object" && typeof b === "object") {
    return a.type === b.type;
  }
  return false;
}

// === Main Function ===

export async function interpret(
  state: TurnWorkingState,
  input: TurnInput,
  deps: InterpretDeps
): Promise<InterpretResult> {
  deps.agentLog(`[interpret] Processing: "${input.userInput.slice(0, 50)}${input.userInput.length > 50 ? "..." : ""}"`);

  // Fetch current status for context (and cache it)
  const { statusInfo } = await fetchStatusInfo(
    deps.client,
    { agentLog: deps.agentLog, agentWarn: deps.agentWarn },
    "Interpreting "
  );
  state.cachedStatusInfo = statusInfo;

  // === Step 1: Rewrite query to fix STT errors ===
  deps.spinner.start("Interpreting");

  const rewriteMessages = buildRewritePrompt(
    input.userInput,
    deps.toolInventory,
    deps.agentPrompts,
    statusInfo
  );

  deps.toLLMLog("[toLLM] ─── Interpret: Rewrite Prompt ───");
  deps.toLLMLog(rewriteMessages[0]?.content ?? "");
  deps.toLLMLog("\n[user]");
  deps.toLLMLog(rewriteMessages[1]?.content ?? "");

  let correctedQuery = await runRewriteQuery(rewriteMessages, deps);

  // Fallback to original if rewrite returned empty
  if (!correctedQuery.trim()) {
    correctedQuery = input.userInput;
    deps.agentLog("[interpret] Rewrite returned empty, using original");
  }

  // === Shortcut: If rewrite is exactly a tool name, skip to execute ===
  const exactToolMatch = findExactToolMatch(correctedQuery, deps.toolInventory);
  if (exactToolMatch) {
    deps.agentLog(`[interpret] Exact tool match: "${exactToolMatch}" - skipping to execute`);
    return { action: "execute", tool: exactToolMatch, interpretedQuery: exactToolMatch };
  }

  // === Step 2: Combine with history (if exists) ===
  let finalQuery = correctedQuery;

  if (state.interpretHistory && state.interpretHistory.length > 0) {
    deps.spinner.update("Combining context");

    const combineMessages = buildCombinePrompt(correctedQuery, state.interpretHistory);

    deps.toLLMLog("[toLLM] ─── Interpret: Combine Prompt ───");
    deps.toLLMLog(combineMessages[0]?.content ?? "");
    deps.toLLMLog("\n[user]");
    deps.toLLMLog(combineMessages[1]?.content ?? "");

    const combined = await runCombineQuery(combineMessages, deps);

    if (combined.trim()) {
      finalQuery = combined;
      deps.agentLog(`[interpret] Combined query: "${finalQuery.slice(0, 100)}"`);
    } else {
      deps.agentLog("[interpret] Combine returned empty, using corrected query only");
    }
  }

  // === Step 3: Route decision ===
  deps.spinner.update("Routing");

  const routeMessages = buildRoutePrompt(
    finalQuery,
    deps.toolInventory,
    deps.agentPrompts,
    statusInfo
  );

  deps.toLLMLog("[toLLM] ─── Interpret: Route Prompt ───");
  deps.toLLMLog(routeMessages[0]?.content ?? "");
  deps.toLLMLog("\n[user]");
  deps.toLLMLog(routeMessages[1]?.content ?? "");

  // Use consensus for routing decision
  let queryIndex = 0;
  const consensusResult = await runWithConsensus<RouteDecision>(
    async (params: SamplingParams) => {
      queryIndex++;
      deps.spinner.update(`Routing (${queryIndex})`);
      return runRouteQuery(routeMessages, params, deps);
    },
    routeDecisionsMatch,
    {
      maxQueries: 3,
      minMatches: 2,
      matchMode: "exact",
    }
  );

  // Log results
  for (const [index, result] of consensusResult.allResults.entries()) {
    const desc = result === "tools" ? "TOOLS" : `${result?.type}: ${result?.content?.slice(0, 40)}...`;
    deps.agentLog(`[interpret] Route ${index + 1}: ${desc}`);
  }

  deps.agentLog(
    `[interpret] Route consensus: ${consensusResult.matchCount}/${consensusResult.queriesRun}`
  );

  const decision = consensusResult.result ?? "tools";

  // === Return result based on routing ===
  if (decision === "tools") {
    deps.agentLog(`[interpret] Proceeding to tools with: "${finalQuery.slice(0, 80)}"`);
    return { action: "proceed", interpretedQuery: finalQuery };
  }

  if (decision.type === "respond") {
    deps.agentLog(`[interpret] Responding directly: "${decision.content.slice(0, 80)}"`);
    return { action: "respond", response: decision.content };
  }

  // decision.type === "ask"
  deps.agentLog(`[interpret] Asking for clarification: "${decision.content.slice(0, 80)}"`);
  return { action: "ask", question: decision.content };
}
