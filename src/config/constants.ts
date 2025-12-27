export const MAX_SEQUENTIAL_PLAN_LENGTH = 6;

export const SINGLE_TOOL_RULES = `RULES:
1. You MUST call the provided tool for this step.
2. Extract argument values from the user's request.
3. Prefer empty arguments unless the user specifies arguments.
4. Do not make up argument values.`;

export const HISTORY_MAX_PROMPTS = 5;
export const HISTORY_PROMPT_TEXT_LIMIT = 140;
export const HISTORY_RESULT_TEXT_LIMIT = 160;
export const HISTORY_EVENT_TEXT_LIMIT = 110;

export const COLOR_CODES = {
  reset: "\u001B[0m",
  toLLM: "\u001B[34m", // blue - prompts sent to model
  fromLLM: "\u001B[32m", // green - model responses
  toTool: "\u001B[33m", // yellow - tool invocations
  fromTool: "\u001B[93m", // bright yellow - tool results
  toHuman: "\u001B[36m", // cyan - agent status for operator
  warn: "\u001B[35m",
  error: "\u001B[31m",
} as const;

export type ColorCode = (typeof COLOR_CODES)[keyof typeof COLOR_CODES];

export const ENABLE_COLOR =
  process.stdout.isTTY &&
  (process.env["NO_COLOR"] ?? "").toLowerCase() !== "1";

export const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
];
