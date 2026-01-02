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
import { generateAgentPrompts } from "./overlay/agent.js";
import { runTurn, type MachineDeps } from "./core/machine.js";
import type { TurnInput, HistoryEntry } from "./core/turn-types.js";
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
  raiseHand,
  sayResult,
  enableSpeechInterrupt,
} from "./ui/input.js";

async function main(): Promise<void> {
  const { config, prompt: cliPrompt } = parseConfig();
  const loggers = createLoggers(config.debug);
  const spinner = createSpinner(config.debug, loggers.agentLog, { raiseHand });

  const ollamaClient = createOllamaClient({
    config,
    spinner,
    toLLMLog: loggers.toLLMLog,
    fromLLMLog: loggers.fromLLMLog,
    agentWarn: loggers.agentWarn,
  });

  spinner.start("Loading");

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
  const { roleForUser, roleForAssistantPromise } = await generateAgentPrompts(toolInventory, client, {
    ollamaClient,
    agentLog: loggers.agentLog,
    agentWarn: loggers.agentWarn,
  });

  // roleForAssistant resolves in background while user reads greeting
  let agentPrompts: { roleForUser: string; roleForAssistant: string } | undefined;
  const getAgentPrompts = async (): Promise<{ roleForUser: string; roleForAssistant: string }> => {
    if (!agentPrompts) {
      agentPrompts = { roleForUser, roleForAssistant: await roleForAssistantPromise };
    }
    return agentPrompts;
  };

  const rl = readline.createInterface({ input, output });

  // Initialize voice listener only if speech is enabled
  if (config.speechEnabled) {
    initVoiceListener(loggers.agentLog);
  }

  // Create conditional speech functions (no-op when disabled)
  const maybeSay = config.speechEnabled ? say : () => {};
  const maybeSayResult = config.speechEnabled ? sayResult : () => {};
  const maybeEnableSpeechInterrupt = config.speechEnabled ? enableSpeechInterrupt : () => {};

  let shuttingDown = false;
  const commandHistory: Array<HistoryEntry & { fullResponse?: string }> = [];
  const interpretHistory: string[] = [];  // Interpreted queries across turns

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (config.speechEnabled) {
      stopVoiceListener();
    }
    rl.close();
    try {
      await transport.close();
    } catch {
      // ignore
    }
  };

  // Single-prompt mode: process once and exit
  if (cliPrompt) {
    loggers.agentLog(`[agent] Single-prompt mode: "${cliPrompt}"`);
    spinner.stop();

    const turnInput: TurnInput = {
      userInput: cliPrompt,
      previousResponse: roleForUser,
      inputSource: "keyboard",
    };

    const machineDeps: MachineDeps = {
      config,
      client,
      ollamaClient,
      toolInventory,
      agentPrompts: await getAgentPrompts(),
      history: [],
      interpretHistory: [],  // Single-prompt mode: no history
      spinner,
      agentLog: loggers.agentLog,
      agentWarn: loggers.agentWarn,
      agentError: loggers.agentError,
      toLLMLog: loggers.toLLMLog,
      toToolLog: loggers.toToolLog,
      fromToolLog: loggers.fromToolLog,
      resultLog: loggers.resultLog,
      say: maybeSay,
      sayResult: maybeSayResult,
      // Single-prompt mode: no interactive input available
      promptUser: async (question: string) => {
        loggers.agentWarn(`[agent] ask_user in single-prompt mode: "${question}" - returning empty`);
        return "";
      },
    };

    const turnOutput = await runTurn(turnInput, machineDeps);
    loggers.agentLog(`[agent] Result: branch=${turnOutput.branch}`);
    loggers.assistantLog(turnOutput.response);
    await shutdown();
    return;
  }

  // Interactive mode
  spinner.stop();
  blankLine(config.debug);
  loggers.assistantLog(roleForUser);
  void maybeSay(roleForUser);
  maybeEnableSpeechInterrupt();
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
      : roleForUser;

    const turnInput: TurnInput = {
      userInput: trimmedInput,
      previousResponse,
      inputSource,
    };

    const machineDeps: MachineDeps = {
      config,
      client,
      ollamaClient,
      toolInventory,
      agentPrompts: await getAgentPrompts(),
      history: commandHistory,
      interpretHistory,
      spinner,
      agentLog: loggers.agentLog,
      agentWarn: loggers.agentWarn,
      agentError: loggers.agentError,
      toLLMLog: loggers.toLLMLog,
      toToolLog: loggers.toToolLog,
      fromToolLog: loggers.fromToolLog,
      resultLog: loggers.resultLog,
      say: maybeSay,
      sayResult: maybeSayResult,
      // Interactive mode: prompt user for clarification via voice or keyboard
      promptUser: async (question: string) => {
        spinner.stop();
        output.write(`\n❓ ${question}\n`);
        void maybeSay(question);
        maybeEnableSpeechInterrupt();
        // Use getNextInput to support both voice and keyboard input
        setVoiceBusy(false);
        const { source, text } = await getNextInput(rl);
        setVoiceBusy(true);
        if (source === "voice") {
          output.write(`clarify> ${text}\n`);
        }
        return text;
      },
    };

    try {
      // Run the state machine
      const turnOutput = await runTurn(turnInput, machineDeps);
      blankLine(config.debug);

      spinner.stop();
      blankLine(config.debug);
      separator(config.debug, "ANSWER");
      loggers.assistantLog(turnOutput.response);
      void maybeSayResult(turnOutput.response);
      maybeEnableSpeechInterrupt();

      commandHistory.push({
        prompt: trimmedInput,
        toolEvents: [],  // TODO: extract from turn output when needed
        finalSummary: truncateMiddle(
          flattenWhitespace(turnOutput.stateSummary),
          HISTORY_RESULT_TEXT_LIMIT
        ),
        fullResponse: turnOutput.response,
      });

      // Persist interpreted query to history for future context
      if (turnOutput.interpretedQuery) {
        interpretHistory.push(turnOutput.interpretedQuery);
        loggers.agentLog(`[agent] Added to interpret history: "${turnOutput.interpretedQuery.slice(0, 50)}..."`);
      }
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
