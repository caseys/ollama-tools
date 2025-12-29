/**
 * Type definitions for the state machine architecture.
 *
 * Key concept: Iteration Groups
 * When a user query requires multiple tools, those iterations form an "iteration group".
 * - Iteration number starts at 1 and increments within the group
 * - When the original query is satisfied, the group ends
 * - History entries track which group they belong to
 */

// === Input Types ===

export interface TurnInput {
  userInput: string;
  previousResponse: string;
  inputSource: "keyboard" | "voice";
}

// === Tool Event ===

export interface ToolEvent {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  result: string;
  success: boolean;
  timestamp: number;
  groupId: string;
}

// === Reminder ===

/**
 * Structured record for carrying forward requirements from tool results.
 * E.g., "Remember to deploy solar panels after the burn"
 */
export interface Reminder {
  toolName: string;
  reason: string;
  sourceToolEventId: string;
}

// === Working State ===

export interface TurnWorkingState {
  // Turn identification
  turnId: string;

  // Iteration group tracking
  groupId: string;
  iteration: number;
  maxIterations: number;

  // Query state
  originalQuery: string;
  remainingQuery: string;

  // Tool execution state
  currentTool: string | undefined;
  groupToolResults: ToolEvent[];
  reminders: Reminder[];

  // Tool selection consensus (set by SELECT_TOOL, read by REFLECT)
  lastToolSelectionResult?: {
    selectedTool: string | undefined;
    consensusCount: number;
    queriesRun: number;
  };
}

// === Output Types ===

export type TurnBranch = "satisfied" | "max_iterations" | "ask" | "error";

export interface TurnOutput {
  response: string;
  stateSummary: string;
  branch: TurnBranch;
}

// === Reflection Decision ===

export type ReflectionDecision =
  | { action: "continue"; remainingQuery: string }
  | { action: "done"; summary: string }
  | { action: "ask"; question: string };

// === History Types ===
// Re-export from utils/history for convenience
export type { HistoryEntry, HistoryToolEvent } from "../utils/history.js";

// === State Machine Types ===

export enum MachineState {
  WAIT_USER = "WAIT_USER",
  SELECT_TOOL = "SELECT_TOOL",
  EXECUTE = "EXECUTE",
  REFLECT_SUMMARIZE = "REFLECT_SUMMARIZE",
  DONE = "DONE",
}
