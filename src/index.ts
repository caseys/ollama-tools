#!/usr/bin/env node
import "dotenv/config";
import process from "node:process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { parseConfig } from "./config/parser.js";
import { HISTORY_RESULT_TEXT_LIMIT } from "./config/constants.js";
import { createLoggers } from "./ui/logger.js";
import { createSpinner } from "./ui/spinner.js";
import { blankLine, separator } from "./ui/output.js";
import { createOllamaClient } from "./core/ollama.js";
import { connectToMcp } from "./mcp/client.js";
import { fetchStatusInfo } from "./mcp/resources.js";
import { generateAgentPrompts } from "./overlay/agent.js";
import { runPipeline, type PipelineContext, type PipelineStep } from "./core/pipeline.js";
import { step as sttCorrectStep } from "./overlay/stt_correct.js";
import { step as preflightStep } from "./overlay/preflight.js";
import { step as planStep } from "./overlay/plan_tools.js";
import { step as executeStep } from "./overlay/execute.js";
import { step as summaryStep } from "./overlay/summary.js";
import { step as clarifyStep } from "./overlay/intro.js";
import type { HistoryEntry } from "./utils/history.js";
import {
  truncateMiddle,
  flattenWhitespace,
} from "./utils/strings.js";
import { describeError } from "./ui/logger.js";
import {
  getNextInput,
  initVoiceListener,
  stopVoiceListener,
  setVoiceBusy,
  say,
} from "./ui/input.js";

// Default pipeline configuration
const defaultPipeline: PipelineStep[] = [
  // overlay/agent is used at startup
  sttCorrectStep,  // Only runs for voice input
  //preflightStep,
  planStep,
  executeStep,
  summaryStep,
  clarifyStep,
];

async function main(): Promise<void> {
  const { config, prompt: cliPrompt } = parseConfig();
  const loggers = createLoggers(config.debug);
  const spinner = createSpinner(config.debug, loggers.agentLog);

  const ollamaClient = createOllamaClient({
    config,
    spinner,
    toLLMLog: loggers.toLLMLog,
    fromLLMLog: loggers.fromLLMLog,
    agentWarn: loggers.agentWarn,
  });

  const { client, toolInventory, resourceInventory, promptInventory, transport } =
    await connectToMcp({
      config,
      agentLog: loggers.agentLog,
      agentWarn: loggers.agentWarn,
    });

  if (resourceInventory.length > 0 || promptInventory.length > 0) {
    loggers.agentLog(
      `[agent] Resources: ${resourceInventory.length}, Prompts: ${promptInventory.length}`
    );
  }

  loggers.agentLog("[agent] Generating agent prompts from tool catalog...");
  const agentPrompts = await generateAgentPrompts(toolInventory, client, {
    ollamaClient,
    agentLog: loggers.agentLog,
    agentWarn: loggers.agentWarn,
  });

  const rl = readline.createInterface({ input, output });

  initVoiceListener(loggers.agentLog);

  let shuttingDown = false;
  const commandHistory: Array<HistoryEntry & { fullResponse?: string }> = [];

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopVoiceListener();
    rl.close();
    try {
      await transport.close();
    } catch {
      // ignore
    }
  };

  const pipelineDeps = {
    config,
    client,
    ollamaClient,
    spinner,
    agentLog: loggers.agentLog,
    agentWarn: loggers.agentWarn,
    agentError: loggers.agentError,
    toLLMLog: loggers.toLLMLog,
    toToolLog: loggers.toToolLog,
    fromToolLog: loggers.fromToolLog,
    say,
  };

  // Single-prompt mode: process once and exit
  if (cliPrompt) {
    loggers.agentLog(`[agent] Single-prompt mode: "${cliPrompt}"`);
    spinner.stop();

    const { statusInfo } = await fetchStatusInfo(client, { agentLog: loggers.agentLog, agentWarn: loggers.agentWarn }, "Planning ");

    const ctx: PipelineContext = {
      userInput: cliPrompt,
      previousResponse: agentPrompts.roleForUser,
      toolInventory,
      agentPrompts,
      history: [],
      statusInfo,
    };

    // Only run preflight and plan for single-prompt mode
    const planOnlyPipeline = [preflightStep, planStep];
    await runPipeline(planOnlyPipeline, ctx, pipelineDeps);

    loggers.agentLog(`[agent] Planning result: ${ctx.plannedTools?.length ?? 0} tools, branch=${ctx.branch}`);
    await shutdown();
    return;
  }

  // Interactive mode
  spinner.stop();
  blankLine(config.debug);
  loggers.assistantLog(agentPrompts.roleForUser);
  void say(agentPrompts.roleForUser);
  blankLine(config.debug);
  loggers.agentLog('[agent] Type or speak a prompt (or "exit" to quit).');

  process.on("SIGINT", async () => {
    loggers.agentLog("\n[agent] Caught Ctrl+C. Shutting down...");
    await shutdown();
    process.exit(0);
  });

  while (true) {
    let userInput: string;
    let inputSource: "keyboard" | "voice" = "keyboard";
    try {
      setVoiceBusy(false);
      const { source, text } = await getNextInput(rl);
      setVoiceBusy(true);
      userInput = text;
      inputSource = source;
      if (source === "voice") {
        output.write(`you> ${text}\n`);
      }
    } catch (error) {
      if (error && typeof error === "object") {
        const code = (error as { code?: string }).code;
        if (code === "ERR_USE_AFTER_CLOSE" || code === "ABORT_ERR") {
          await shutdown();
          break;
        }
      }
      throw error;
    }

    const trimmedInput = userInput.trim();
    if (!trimmedInput) continue;
    if (["exit", "quit"].includes(trimmedInput.toLowerCase())) {
      await shutdown();
      break;
    }

    const lastEntry = commandHistory.at(-1);
    const previousResponse = lastEntry?.fullResponse
      ? truncateMiddle(lastEntry.fullResponse, 1000)
      : agentPrompts.roleForUser;

    const { statusInfo } = await fetchStatusInfo(
      client,
      { agentLog: loggers.agentLog, agentWarn: loggers.agentWarn },
      "Planning "
    );

    const ctx: PipelineContext = {
      userInput: trimmedInput,
      previousResponse,
      inputSource,
      toolInventory,
      agentPrompts,
      history: commandHistory,
      statusInfo,
    };

    try {
      // Run the full pipeline
      await runPipeline(defaultPipeline, ctx, pipelineDeps);
      blankLine(config.debug);

      if (ctx.branch === "execute" && ctx.plannedTools && ctx.plannedTools.length > 0) {
        separator(config.debug, "EXECUTION");
        loggers.agentLog(
          `Ran ${ctx.plannedTools.length} tools: ${ctx.plannedTools.join(" → ")}`
        );
      }

      const answer = ctx.response ?? "I could not determine which tools to use for your request. Please try rephrasing.";

      spinner.stop();
      blankLine(config.debug);
      separator(config.debug, "ANSWER");
      loggers.assistantLog(answer);
      void say(answer);

      commandHistory.push({
        prompt: trimmedInput,
        toolEvents: (ctx.toolResults ?? []).map((e) => ({
          name: e.tool,
          success: e.status === "success",
        })),
        finalSummary: truncateMiddle(
          flattenWhitespace(answer),
          HISTORY_RESULT_TEXT_LIMIT
        ),
        fullResponse: answer,
      });
    } catch (error) {
      spinner.stop();
      loggers.agentError(`[agent] Failed to get answer: ${describeError(error)}`);
    }
    blankLine(config.debug);
  }

  await shutdown();
}

try {
  await main();
} catch (error) {
  console.error("[agent] Fatal error:", error);
  process.exit(1);
}
