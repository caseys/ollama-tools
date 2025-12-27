import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Config, AgentPrompts, ToolEvent } from "../types.js";
import type { Logger, ToolLogger } from "../ui/logger.js";
import type { Spinner } from "../ui/spinner.js";
import type { OllamaClient } from "./ollama.js";
import type { InventoryEntry } from "../utils/tools.js";
import type { HistoryEntry } from "../utils/history.js";

// Re-export utilities for steps to use
export {
  runWithRetry,
  retryOnEmpty,
  retryOnError,
  type RetryConfig,
} from "./retry.js";
export {
  runWithConsensus,
  arraysOverlap,
  arraysShareAtLeast,
  type ConsensusConfig,
  type ConsensusResult,
} from "./consensus.js";

// --- Pipeline Context ---

export interface PipelineContext {
  // Input
  userInput: string;
  previousResponse: string;
  inputSource?: "keyboard" | "voice";

  // Accumulated state
  expandedRequest?: string;
  plannedTools?: string[];
  toolResults?: ToolEvent[];
  response?: string;
  stateSummary?: string;
  reflectionStopped?: { reason: string };
  reflectionQuestion?: string;

  // Shared resources
  toolInventory: InventoryEntry[];
  agentPrompts: AgentPrompts;
  history: HistoryEntry[];
  statusInfo?: string;

  // Control flow
  skipRemaining?: boolean;
  branch?: "execute" | "clarify" | "error";
}

// --- Pipeline Step ---

export interface PipelineStep {
  name: string;
  enabled: boolean;
  shouldRun?: (ctx: PipelineContext) => boolean;
  run: (ctx: PipelineContext, deps: PipelineDeps) => Promise<void>;
}

// --- Pipeline Dependencies ---

export interface PipelineDeps {
  config: Config;
  client: Client;
  ollamaClient: OllamaClient;
  spinner: Spinner;
  agentLog: Logger;
  agentWarn: Logger;
  agentError: Logger;
  toLLMLog: Logger;
  toToolLog: ToolLogger;
  fromToolLog: ToolLogger;
  say: (text: string) => void;
}

// --- Pipeline Runner ---

export async function runPipeline(
  steps: PipelineStep[],
  ctx: PipelineContext,
  deps: PipelineDeps
): Promise<PipelineContext> {
  for (const step of steps) {
    if (!step.enabled) {
      deps.agentLog(`[pipeline] Skipping ${step.name} (disabled)`);
      continue;
    }
    if (step.shouldRun && !step.shouldRun(ctx)) {
      deps.agentLog(`[pipeline] Skipping ${step.name} (condition not met)`);
      continue;
    }
    if (ctx.skipRemaining) {
      deps.agentLog(`[pipeline] Skipping ${step.name} (skipRemaining=true)`);
      break;
    }

    deps.agentLog(`[pipeline] Running ${step.name}...`);
    await step.run(ctx, deps);
  }
  return ctx;
}

// --- Helper to create enabled step ---

export function createStep(
  name: string,
  run: PipelineStep["run"],
  shouldRun?: (ctx: PipelineContext) => boolean
): PipelineStep {
  const step: PipelineStep = {
    name,
    enabled: true,
    run,
  };
  if (shouldRun) {
    step.shouldRun = shouldRun;
  }
  return step;
}
