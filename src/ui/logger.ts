import fs from "node:fs";
import process from "node:process";
import { COLOR_CODES, ENABLE_COLOR, type ColorCode } from "../config/constants.js";

const LOG_FILE = process.env["LOG_FILE"];
let logStream: fs.WriteStream | undefined;

if (LOG_FILE) {
  logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
}

export function writeToLogFile(message: string): void {
  if (logStream) {
    const timestamp = new Date().toISOString();
    logStream.write(`[${timestamp}] ${message}\n`);
  }
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function colorize(message: string, color: ColorCode | undefined): string {
  if (!ENABLE_COLOR || !color) {
    return message;
  }
  return `${color}${message}${COLOR_CODES.reset}`;
}

type ConsoleMethod = "log" | "warn" | "error";

export interface Logger {
  (message: string, ...rest: unknown[]): void;
}

export function makeLogger(
  method: ConsoleMethod,
  color: ColorCode | undefined,
  isDebugOnly: boolean,
  debugMode: boolean
): Logger {
  return (message: string, ...rest: unknown[]): void => {
    const fullMessage =
      rest.length > 0 ? `${message} ${rest.join(" ")}` : message;
    writeToLogFile(fullMessage);

    if (!isDebugOnly || debugMode) {
      if (rest.length > 0) {
        console[method](colorize(message, color), ...rest);
      } else {
        console[method](colorize(message, color));
      }
    }
  };
}

export interface ToolLogger {
  (toolName: string, message: string, ...rest: unknown[]): void;
}

export function makeToolLogger(
  direction: "to" | "from",
  debugMode: boolean
): ToolLogger {
  const colorCode =
    direction === "to" ? COLOR_CODES.toTool : COLOR_CODES.fromTool;

  return function (toolName: string, message: string, ...rest: unknown[]): void {
    const label = `[${direction}Tool-${toolName}]`;
    const formatted = `${label} ${message}`;
    const fullMessage =
      rest.length > 0 ? `${formatted} ${rest.join(" ")}` : formatted;
    writeToLogFile(fullMessage);

    if (debugMode) {
      if (rest.length > 0) {
        console.log(colorize(formatted, colorCode), ...rest);
      } else {
        console.log(colorize(formatted, colorCode));
      }
    }
  };
}

export interface Loggers {
  agentLog: Logger;
  agentWarn: Logger;
  agentError: Logger;
  fromLLMLog: Logger;
  toLLMLog: Logger;
  assistantLog: Logger;
  toToolLog: ToolLogger;
  fromToolLog: ToolLogger;
}

export function createLoggers(debugMode: boolean): Loggers {
  return {
    agentLog: makeLogger("log", COLOR_CODES.toHuman, true, debugMode),
    agentWarn: makeLogger("warn", COLOR_CODES.warn, true, debugMode),
    agentError: makeLogger("error", COLOR_CODES.error, false, debugMode),
    fromLLMLog: makeLogger("log", COLOR_CODES.fromLLM, true, debugMode),
    toLLMLog: makeLogger("log", COLOR_CODES.toLLM, true, debugMode),
    assistantLog: makeLogger("log", COLOR_CODES.fromLLM, false, debugMode),
    toToolLog: makeToolLogger("to", debugMode),
    fromToolLog: makeToolLogger("from", debugMode),
  };
}
