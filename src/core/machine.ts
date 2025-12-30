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
import { selectTool } from "../overlay/select-tool.js";
import { executeTool } from "../overlay/execute-tool.js";
import { reflectAndSummarize } from "../overlay/reflect.js";

// === Constants ===

const MAX_ITERATIONS = 6;

// === Dependencies ===

export interface MachineDeps {
  config: Config;
  client: Client;
  ollamaClient: OllamaClient;
  toolInventory: InventoryEntry[];
  agentPrompts: AgentPrompts;
  history: HistoryEntry[];
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
  // For ask_user escape hatch - prompts user for clarification during tool execution
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
  };

  let machineState: MachineState = MachineState.SELECT_TOOL;

  // State machine loop - exits via return statements
  while (true) {
    deps.agentLog(`[machine] State: ${machineState}, iteration: ${state.iteration}`);

    switch (machineState) {
      case MachineState.SELECT_TOOL: {
        state.iteration++;

        // Check iteration limit
        if (state.iteration > state.maxIterations) {
          deps.agentLog("[machine] Max iterations reached");
          return {
            response: "Maximum iterations reached. " + buildStateSummary(state),
            stateSummary: buildStateSummary(state),
            branch: "max_iterations",
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

        // Check for ask_user escape hatch - needs user clarification
        if (toolEvent.needsUserInput) {
          const question = toolEvent.result;
          deps.agentLog(`[machine] ask_user triggered: "${question}"`);

          // Don't add to groupToolResults - this is internal clarification
          // Prompt the user and prepend their answer for the retry
          const userAnswer = await deps.promptUser(question);
          deps.agentLog(`[machine] User clarification: "${userAnswer}"`);

          // Prepend user's answer so it's prominent for argument extraction
          state.remainingQuery = `[User clarified "${question}": ${userAnswer}]\n\n${state.remainingQuery}`;

          // Stay in EXECUTE with same currentTool - retry the tool call
          // Note: currentTool is already set, don't clear it
          break;
        }

        // Normal flow - add to results and go to reflect
        state.groupToolResults.push(toolEvent);
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
        });

        if (decision.action === "continue") {
          state.remainingQuery = decision.remainingQuery;
          machineState = MachineState.SELECT_TOOL;
        } else if (decision.action === "ask") {
          return {
            response: decision.question,
            stateSummary: buildStateSummary(state),
            branch: "ask",
          };
        } else {
          // action === "done"
          return {
            response: decision.summary,
            stateSummary: buildStateSummary(state),
            branch: "satisfied",
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
  };
}
