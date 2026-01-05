import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

export interface Config {
  model: string;
  ollamaUrl: string;
  transport: "stdio" | "http";
  mcpBin: string;
  mcpHttpUrl: string;
  maxRetries: number;
  toolTimeout: number;
  debug: boolean;
  speechEnabled: boolean;
}

export interface ParseResult {
  config: Config;
  prompt: string | undefined;
}

export interface ToolParameter {
  type: string;
  description?: string;
  enum?: string[];
  default?: unknown;
}

export interface ToolInputSchema {
  type: "object";
  properties?: Record<string, ToolParameter> | undefined;
  required?: string[] | undefined;
}

export interface ToolEntry {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  tier?: number;
}

export interface OllamaFunction {
  name: string;
  description: string;
  parameters: ToolInputSchema;
}

export interface OllamaTool {
  type: "function";
  function: OllamaFunction;
}

export interface ToolEvent {
  tool: string;
  args: Record<string, unknown>;
  result: string;
  status: "success" | "failure";
}

export interface PlanResult {
  sequence: string[];
}

export interface McpConnection<TTransport = unknown, TToolInventory = unknown> {
  client: Client;
  toolInventory: TToolInventory;
  resourceInventory: McpResource[];
  promptInventory: McpPrompt[];
  transport: TTransport;
}

export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: McpPromptArgument[];
}

export interface McpPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface StatusInfo {
  universalTime?: number;
  vesselName?: string;
  situation?: string;
  altitude?: number;
  orbitalVelocity?: number;
  apoapsis?: number;
  periapsis?: number;
  target?: string;
  [key: string]: unknown;
}

export interface CommandHistoryEntry {
  prompt: string;
  tools: string[];
  toolEvents: ToolEvent[];
  response: string;
}

export interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
}

export interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface OllamaResponse {
  message: OllamaMessage;
  done: boolean;
  eval_count?: number;
  prompt_eval_count?: number;
}

export interface ParsedToolsResult {
  type: "empty" | "tools";
  tools?: string[];
}

export interface InputResult {
  source: "keyboard" | "voice";
  text: string;
}

export interface AgentPrompts {
  roleForUser: string;
  roleForAssistant: string;
}

export interface AgentPromptsLazy {
  roleForUser: string;
  roleForAssistantPromise: Promise<string>;
  statusInfo: string;
}

export interface PreflightResult {
  expandedRequest: string;
}

export interface ToolExecutionResult {
  toolEvents: ToolEvent[];
  stopped?: { reason: string };
  question?: string;
}

export type ReflectionDecision =
  | { action: "continue" }
  | { action: "stop"; reason: string }
  | { action: "replan"; tools: string[]; reason: string }
  | { action: "ask"; question: string };

export type LogLevel = "debug" | "info" | "warn" | "error";
