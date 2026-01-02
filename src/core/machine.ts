/**
 * State Machine Orchestrator
 *
 * Thin orchestrator (~100-130 lines) that manages state transitions.
 * All logic lives in overlay modules; this file only handles control flow.
 *
 * States: WAIT_USER → SELECT_TOOL → EXECUTE → REFLECT_SUMMARIZE → (loop or done)
 */

import { randomUUID } from "node:crypto";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Config, AgentPrompts } from "../types.js";
import type { Logger, ToolLogger, ResultLogger } from "../ui/logger.js";
import type { Spinner } from "../ui/spinner.js";
import type { OllamaClient } from "./ollama.js";
import type { InventoryEntry } from "../utils/tools.js";
import type { HistoryEntry } from "../utils/history.js";
import {
  MachineState,
  type TurnInput,
  type TurnWorkingState,
  type TurnOutput,
} from "./turn-types.js";

// Import state handlers from overlays
import { interpret } from "../overlay/interpret.js";
import { selectTool } from "../overlay/select-tool.js";
import { executeTool } from "../overlay/execute-tool.js";
import { reflectAndSummarize } from "../overlay/reflect.js";

// === Constants ===

const MAX_ITERATIONS = 20;

// === Dependencies ===

export interface MachineDeps {
  config: Config;
  client: Client;
  ollamaClient: OllamaClient;
  toolInventory: InventoryEntry[];
  agentPrompts: AgentPrompts;
  history: HistoryEntry[];
  interpretHistory: string[];  // Previous interpreted queries (persisted across turns)
  spinner: Spinner;
  agentLog: Logger;
  agentWarn: Logger;
  agentError: Logger;
  toLLMLog: Logger;
  toToolLog: ToolLogger;
  fromToolLog: ToolLogger;
  resultLog: ResultLogger;
  say: (text: string) => void;
  sayResult: (text: string) => void;
  // Prompts user for clarification when LLM can't extract tool arguments
  promptUser: (question: string) => Promise<string>;
}

// === State Summary Builder ===

function buildStateSummary(state: TurnWorkingState): string {
  const successful = state.groupToolResults.filter((e) => e.success);
  if (successful.length === 0) return "No actions completed.";
  return successful
    .map((e) => `${e.toolName}: ${e.result.split("\n")[0]}`)
    .join("; ");
}

// === Main Runner ===

export async function runTurn(
  input: TurnInput,
  deps: MachineDeps
): Promise<TurnOutput> {
  const turnId = randomUUID();
  const groupId = randomUUID();

  // Initialize working state
  const state: TurnWorkingState = {
    turnId,
    groupId,
    iteration: 0,
    maxIterations: MAX_ITERATIONS,
    originalQuery: input.userInput,
    remainingQuery: input.userInput,
    currentTool: undefined,
    groupToolResults: [],
    reminders: [],
    failedTools: [],
    executeRetryCount: 0,
    interpretHistory: deps.interpretHistory,
  };

  let machineState: MachineState = MachineState.INTERPRET;
  let interpretedQuery: string | undefined;

  // State machine loop - exits via return statements
  while (true) {
    deps.agentLog(`[machine] State: ${machineState}, iteration: ${state.iteration}`);

    switch (machineState) {
      case MachineState.INTERPRET: {
        const result = await interpret(state, input, {
          config: deps.config,
          client: deps.client,
          ollamaClient: deps.ollamaClient,
          toolInventory: deps.toolInventory,
          agentPrompts: deps.agentPrompts,
          spinner: deps.spinner,
          agentLog: deps.agentLog,
          agentWarn: deps.agentWarn,
          toLLMLog: deps.toLLMLog,
        });

        if (result.action === "respond") {
          deps.agentLog(`[machine] INTERPRET returned response directly`);
          return {
            response: result.response,
            stateSummary: "",
            branch: "satisfied",
            // No interpretedQuery for direct responses - not adding to history
          };
        }

        if (result.action === "ask") {
          deps.agentLog(`[machine] INTERPRET needs clarification`);
          return {
            response: result.question,
            stateSummary: "",
            branch: "ask",
            // No interpretedQuery for ask - not adding to history yet
          };
        }

        if (result.action === "execute") {
          // Direct tool match - skip SELECT_TOOL and go straight to EXECUTE
          deps.agentLog(`[machine] INTERPRET matched tool directly: ${result.tool}`);
          interpretedQuery = result.interpretedQuery;
          state.remainingQuery = result.interpretedQuery;
          state.currentTool = result.tool;
          state.iteration++;
          console.log(`Tool: ${result.tool}`);
          machineState = MachineState.EXECUTE;
          break;
        }

        // action === "proceed"
        interpretedQuery = result.interpretedQuery;
        state.remainingQuery = result.interpretedQuery;
        deps.agentLog(`[machine] INTERPRET proceeding with: "${result.interpretedQuery.slice(0, 60)}..."`);
        machineState = MachineState.SELECT_TOOL;
        break;
      }

      case MachineState.SELECT_TOOL: {
        state.iteration++;

        // Check iteration limit
        if (state.iteration > state.maxIterations) {
          deps.agentLog("[machine] Max iterations reached");
          return {
            response: "Maximum iterations reached. " + buildStateSummary(state),
            stateSummary: buildStateSummary(state),
            branch: "max_iterations",
            ...(interpretedQuery && { interpretedQuery }),
          };
        }

        // Select the next tool
        const selectionResult = await selectTool(state, input, {
          config: deps.config,
          client: deps.client,
          ollamaClient: deps.ollamaClient,
          toolInventory: deps.toolInventory,
          agentPrompts: deps.agentPrompts,
          history: deps.history,
          spinner: deps.spinner,
          agentLog: deps.agentLog,
          agentWarn: deps.agentWarn,
          toLLMLog: deps.toLLMLog,
        });

        state.currentTool = selectionResult.tool;
        state.lastToolSelectionResult = {
          selectedTool: selectionResult.tool,
          consensusCount: selectionResult.consensusCount,
          queriesRun: selectionResult.queriesRun,
        };

        if (selectionResult.tool) {
          deps.agentLog(`[machine] Selected: ${selectionResult.tool}`);
          console.log(`Tool: ${selectionResult.tool}`);
          // Speech handled by spinner.start() in executeTool with { latest: true }
          machineState = MachineState.EXECUTE;
        } else if (selectionResult.question) {
          // LLM returned a question instead of a tool - ask the user
          deps.agentLog(`[machine] SELECT_TOOL returned question: "${selectionResult.question.slice(0, 60)}..."`);
          return {
            response: selectionResult.question,
            stateSummary: buildStateSummary(state),
            branch: "ask",
            ...(interpretedQuery && { interpretedQuery }),
          };
        } else if (selectionResult.isDone) {
          // LLM explicitly said "done" - skip to reflect for summary
          deps.agentLog(`[machine] SELECT_TOOL returned done, moving to reflect for summary`);
          machineState = MachineState.REFLECT_SUMMARIZE;
        } else {
          deps.agentLog(`[machine] No tool selected (${selectionResult.consensusCount}/${selectionResult.queriesRun} consensus), moving to reflect`);
          machineState = MachineState.REFLECT_SUMMARIZE;
        }
        break;
      }

      case MachineState.EXECUTE: {
        const toolEvent = await executeTool(state, {
          config: deps.config,
          client: deps.client,
          ollamaClient: deps.ollamaClient,
          toolInventory: deps.toolInventory,
          agentPrompts: deps.agentPrompts,
          spinner: deps.spinner,
          agentLog: deps.agentLog,
          agentWarn: deps.agentWarn,
          agentError: deps.agentError,
          toToolLog: deps.toToolLog,
          fromToolLog: deps.fromToolLog,
          resultLog: deps.resultLog,
          say: deps.say,
          sayResult: deps.sayResult,
        });

        // Check for text-only response (LLM didn't call tool)
        if (toolEvent.llmTextResponse) {
          const MAX_EXECUTE_RETRIES = 2;
          state.executeRetryCount++;

          if (state.executeRetryCount < MAX_EXECUTE_RETRIES) {
            // Retry - add context about the failure
            deps.agentLog(`[machine] LLM text response, retry ${state.executeRetryCount}/${MAX_EXECUTE_RETRIES}`);
            state.remainingQuery = `[Previous attempt returned text: "${toolEvent.llmTextResponse.slice(0, 100)}"]\n\n${state.remainingQuery}`;
            // Stay in EXECUTE with same currentTool
            break;
          }

          // Max retries reached - prompt user with the LLM's text as a question
          deps.agentLog(`[machine] Max retries reached, prompting user with: "${toolEvent.llmTextResponse.slice(0, 100)}"`);
          const userAnswer = await deps.promptUser(toolEvent.llmTextResponse);
          deps.agentLog(`[machine] User clarification: "${userAnswer}"`);

          // Prepend user's answer and retry
          state.remainingQuery = `[User clarified: ${userAnswer}]\n\n${state.remainingQuery}`;
          state.executeRetryCount = 0;  // Reset for next attempt
          break;
        }

        // Reset retry count on successful tool call
        state.executeRetryCount = 0;

        // Normal flow - add to results and go to reflect
        state.groupToolResults.push(toolEvent);

        // Track failed tools for selection avoidance
        if (!toolEvent.success && !state.failedTools.includes(toolEvent.toolName)) {
          state.failedTools.push(toolEvent.toolName);
        }

        state.currentTool = undefined;
        machineState = MachineState.REFLECT_SUMMARIZE;
        break;
      }

      case MachineState.REFLECT_SUMMARIZE: {
        const decision = await reflectAndSummarize(state, input, {
          config: deps.config,
          client: deps.client,
          ollamaClient: deps.ollamaClient,
          toolInventory: deps.toolInventory,
          agentPrompts: deps.agentPrompts,
          spinner: deps.spinner,
          agentLog: deps.agentLog,
          agentWarn: deps.agentWarn,
          toLLMLog: deps.toLLMLog,
        });

        if (decision.action === "continue") {
          state.remainingQuery = decision.remainingQuery;
          machineState = MachineState.SELECT_TOOL;
        } else if (decision.action === "ask") {
          return {
            response: decision.question,
            stateSummary: buildStateSummary(state),
            branch: "ask",
            ...(interpretedQuery && { interpretedQuery }),
          };
        } else {
          // action === "done"
          return {
            response: decision.summary,
            stateSummary: buildStateSummary(state),
            branch: "satisfied",
            ...(interpretedQuery && { interpretedQuery }),
          };
        }
        break;
      }

    }
  }

  // Should not reach here
  return {
    response: "Turn completed unexpectedly",
    stateSummary: buildStateSummary(state),
    branch: "error",
    ...(interpretedQuery && { interpretedQuery }),
  };
}
