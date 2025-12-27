#!/usr/bin/env node
/**
 * Lightweight agent loop that lets an Ollama model call MCP tools from ksp-mcp.
 *
 * Flow:
 *  1. Connect to the MCP server (stdio by default, HTTP optional) and read tool schemas.
 *  2. Present those tools to Ollama (/api/chat) using OpenAI-style function definitions.
 *  3. When the model emits tool_calls, run the real MCP tool and feed the result back in.
 *  4. Continue until the model answers the user.
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { say, hear } from 'hear-say';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MAX_SEQUENTIAL_PLAN_LENGTH = 6;

const SINGLE_TOOL_RULES = `RULES:
1. You MUST call the provided tool for this step.
2. Extract argument values from the user's request.
3. Prefer empty arguments unless the user specifies arguments.
4. Do not make up argument values.`;

const HISTORY_MAX_PROMPTS = 5;
const HISTORY_PROMPT_TEXT_LIMIT = 140;
const HISTORY_RESULT_TEXT_LIMIT = 160;
const HISTORY_EVENT_TEXT_LIMIT = 110;
const COLOR_CODES = {
  reset: '\u001B[0m',
  toLLM: '\u001B[34m',      // blue - prompts sent to model
  fromLLM: '\u001B[32m',    // green - model responses
  toTool: '\u001B[33m',     // yellow - tool invocations
  fromTool: '\u001B[93m',   // bright yellow - tool results
  toHuman: '\u001B[36m',    // cyan - agent status for operator
  warn: '\u001B[35m',
  error: '\u001B[31m',
};
const ENABLE_COLOR =
  process.stdout.isTTY &&
  (process.env.NO_COLOR ?? '').toLowerCase() !== '1';

// File logging setup
const LOG_FILE = process.env.LOG_FILE;
let logStream;
if (LOG_FILE) {
  logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
}

function writeToLogFile(message) {
  if (logStream) {
    const timestamp = new Date().toISOString();
    logStream.write(`[${timestamp}] ${message}\n`);
  }
}

// Debug mode flag (set after config is parsed)
let debugMode = false;

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function colorize(message, color) {
  if (!ENABLE_COLOR || !color) {
    return message;
  }
  return `${color}${message}${COLOR_CODES.reset}`;
}

function makeLogger(method, color, isDebugOnly = true) {
  return (message, ...rest) => {
    const fullMessage = rest.length > 0 ? `${message} ${rest.join(' ')}` : String(message);
    writeToLogFile(fullMessage);

    // Only show to console if: not debug-only, OR debug mode is enabled
    if (!isDebugOnly || debugMode) {
      if (rest.length > 0) {
        console[method](colorize(message, color), ...rest);
      } else {
        console[method](colorize(message, color));
      }
    }
  };
}

function blankLine() {
  if (debugMode) {
    process.stdout.write('\n');
  }
}

function separator(label = '') {
  if (!debugMode) return;
  const line = '─'.repeat(10);
  if (label) {
    console.log(colorize(`${line} ${label} ${line}`, COLOR_CODES.toHuman));
  } else {
    console.log(colorize(line, COLOR_CODES.toHuman));
  }
}

// Debug-only loggers (hidden in default mode)
const agentLog = makeLogger('log', COLOR_CODES.toHuman, true);
const agentWarn = makeLogger('warn', COLOR_CODES.warn, true);
const agentError = makeLogger('error', COLOR_CODES.error, false); // errors always shown
const fromLLMLog = makeLogger('log', COLOR_CODES.fromLLM, true);
const toLLMLog = makeLogger('log', COLOR_CODES.toLLM, true);

// Always-shown logger (for final assistant answers)
const assistantLog = makeLogger('log', COLOR_CODES.fromLLM, false);

// Tool loggers with dynamic tool name in label (debug-only)
function makeToolLogger(direction) {
  const colorCode = direction === 'to' ? COLOR_CODES.toTool : COLOR_CODES.fromTool;
  return function(toolName, message, ...rest) {
    const label = `[${direction}Tool-${toolName}]`;
    const formatted = `${label} ${message}`;
    const fullMessage = rest.length > 0 ? `${formatted} ${rest.join(' ')}` : formatted;
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

const toToolLog = makeToolLogger('to');
const fromToolLog = makeToolLogger('from');

// Voice I/O state
let voiceBusy = true; // Start busy until ready
let voicePendingResolve;

/**
 * Format tool list for speech (e.g., "foo, bar and baz")
 */
function formatToolListForSpeech(tools) {
  if (tools.length === 0) return 'no';
  if (tools.length === 1) return tools[0].replaceAll('_', ' ');
  const readable = tools.map((t) => t.replaceAll('_', ' '));
  return readable.slice(0, -1).join(', ') + ' and ' + readable.at(-1);
}

/**
 * Get next input from keyboard or voice (whichever comes first)
 */
function getNextInput(rl) {
  return new Promise((resolve) => {
    voicePendingResolve = resolve;

    // Also accept keyboard input
    rl.question('you> ').then((text) => {
      if (voicePendingResolve === resolve) {
        voicePendingResolve = undefined;
        resolve({ source: 'keyboard', text });
      }
    });
  });
}

/**
 * Initialize continuous voice listener
 */
function initVoiceListener() {
  hear((text) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    if (voiceBusy) {
      say("Hold on, I'm busy.");
      agentLog(`[voice] (ignored while busy) "${trimmed}"`);
    } else if (voicePendingResolve) {
      agentLog(`[voice] "${trimmed}"`);
      const resolve = voicePendingResolve;
      voicePendingResolve = undefined;
      resolve({ source: 'voice', text: trimmed });
    }
  });
}

const {
  values: {
    model,
    ollamaUrl,
    transport,
    mcpBin,
    mcpHttpUrl,
    maxRetries,
    toolTimeout,
    debug,
  },
} = parseArgs({
  options: {
    model: {
      type: 'string',
      default: process.env.OLLAMA_MODEL ?? 'llama3.2:3b-instruct-q4_K_M',
    },
    ollamaUrl: {
      type: 'string',
      default: process.env.OLLAMA_URL ?? 'http://localhost:11434',
    },
    transport: {
      type: 'string',
      default: process.env.MCP_TRANSPORT ?? 'stdio',
    },
    mcpBin: {
      type: 'string',
      default:
        process.env.MCP_BIN ??
        path.resolve(__dirname, '../ksp-mcp/dist/index.js'),
    },
    mcpHttpUrl: {
      type: 'string',
      default: process.env.MCP_HTTP_URL ?? 'http://127.0.0.1:3000/mcp',
    },
    maxRetries: {
      type: 'string',
      default: process.env.MAX_RETRIES ?? '3',
    },
    toolTimeout: {
      type: 'string',
      default: process.env.TOOL_TIMEOUT ?? '900000',  // 15 minutes for long-running ops
    },
    debug: {
      type: 'boolean',
      default: process.env.DEBUG === '1' || process.env.DEBUG === 'true',
    },
  },
  allowPositionals: false,
});

function resolveMcpBin(binPath) {
  if (!binPath) {
    return binPath;
  }
  return path.isAbsolute(binPath)
    ? binPath
    : path.resolve(process.cwd(), binPath);
}

// Validate and clamp numeric options to sensible defaults
function parsePositiveInt(value, defaultValue) {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) || parsed < 1 ? defaultValue : parsed;
}

const config = {
  model,
  ollamaUrl,
  transport: transport.toLowerCase(),
  mcpBin: resolveMcpBin(mcpBin),
  mcpHttpUrl,
  maxRetries: parsePositiveInt(maxRetries, 3),
  toolTimeout: parsePositiveInt(toolTimeout, 600_000),
  debug: Boolean(debug),
};

// Set debug mode now that config is available
debugMode = config.debug;

// Progress spinner for non-debug mode
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinnerInterval;
let spinnerIndex = 0;

function startSpinner(message = 'Thinking') {
  if (debugMode) return; // Don't show spinner in debug mode
  stopSpinner(); // Stop any existing spinner first
  spinnerIndex = 0;
  spinnerInterval = setInterval(() => {
    process.stdout.write(`\r${SPINNER_FRAMES[spinnerIndex++ % SPINNER_FRAMES.length]} ${message}...`);
  }, 80);
}

function stopSpinner() {
  if (spinnerInterval) {
    clearInterval(spinnerInterval);
    spinnerInterval = undefined;
    process.stdout.write('\r\u001B[K'); // Clear line
  }
}

function updateSpinner(message) {
  if (spinnerInterval && !debugMode) {
    process.stdout.write(`\r\u001B[K${SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length]} ${message}`);
  } else if (debugMode) {
    agentLog(`[Progress] ${message}`);
  }
}

if (!['stdio', 'http'].includes(config.transport)) {
  console.error(
    `Unsupported MCP transport "${config.transport}". Use "stdio" or "http".`,
  );
  process.exit(1);
}

/**
 * Connect to the MCP server (stdio or HTTP) and return the loaded tool schemas.
 */
async function connectToMcp() {
  agentLog(
    `[agent] Connecting to MCP server (${config.transport}) to read tools...`,
  );

  let transportInstance;
  if (config.transport === 'stdio') {
    const { command, args } = buildStdioCommand();
    transportInstance = new StdioClientTransport({
      command,
      args,
      cwd: path.dirname(config.mcpBin),
      env: process.env,
      stderr: 'pipe',
    });

    const stderrStream = transportInstance.stderr;
    if (stderrStream) {
      stderrStream.on('data', (chunk) => {
        const text = chunk.toString().trim();
        if (text.length > 0) {
          console.error(`[ksp-mcp] ${text}`);
        }
      });
    }
  } else {
    const url = new URL(config.mcpHttpUrl);
    transportInstance = new StreamableHTTPClientTransport(url);
  }

  const client = new Client({
    name: 'ollama-local-agent',
    version: '0.1.0',
  });

  await client.connect(transportInstance);
  const { tools } = await client.listTools({});
  const toolInventory = convertToolsForOllama(tools);

  // List resources
  let resourceInventory = [];
  try {
    const { resources } = await client.listResources({});
    resourceInventory = resources || [];
    agentLog(`[agent] Loaded ${resourceInventory.length} MCP resources.`);
  } catch {
    agentWarn('[agent] Failed to list resources (server may not support them).');
  }

  // List prompts
  let promptInventory = [];
  try {
    const { prompts } = await client.listPrompts({});
    promptInventory = prompts || [];
    agentLog(`[agent] Loaded ${promptInventory.length} MCP prompts.`);
  } catch {
    agentWarn('[agent] Failed to list prompts (server may not support them).');
  }

  agentLog(
    `[agent] Loaded ${tools.length} MCP tools and exposed them to Ollama.`,
  );

  return {
    client,
    toolInventory,
    resourceInventory,
    promptInventory,
    transport: transportInstance,
  };
}

function buildStdioCommand() {
  const bin = config.mcpBin;
  if (!bin) {
    throw new Error('MCP binary path is not configured.');
  }
  const extension = path.extname(bin).toLowerCase();
  const isJs = ['.js', '.mjs', '.cjs'].includes(extension);
  if (isJs) {
    return {
      command: process.execPath,
      args: [bin, '--transport', 'stdio'],
    };
  }
  return {
    command: bin,
    args: ['--transport', 'stdio'],
  };
}

function convertToolsForOllama(tools) {
  return tools.map((tool) => {
    const openAiTool = {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description ?? 'MCP tool',
        parameters:
          tool.inputSchema ??
          {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
      },
    };

    const parameterKeys = Object.keys(
      openAiTool.function.parameters?.properties ?? {},
    );

    return {
      openAi: openAiTool,
      parameterKeys,
      tier: tool._meta?.tier ?? 2,
      annotations: tool.annotations ?? {},
      isReadOnly: tool.annotations?.readOnlyHint ?? false,
      isDestructive: tool.annotations?.destructiveHint ?? false,
    };
  });
}

/**
 * Read a resource and parse JSON if applicable.
 * Returns parsed data or raw text, undefined on error.
 */
async function readResource(client, uri) {
  try {
    const result = await client.readResource({ uri });
    const content = result.contents?.[0];
    if (!content) return;

    // Parse JSON if mime type indicates
    if (content.mimeType === 'application/json') {
      return JSON.parse(content.text);
    }
    return content.text;
  } catch (error) {
    agentWarn(`[agent] Failed to read resource ${uri}: ${describeError(error)}`);
    return;
  }
}

/**
 * Format status resource data for display.
 * Domain-agnostic: handles pre-formatted strings or structured objects.
 */
function formatStatusResource(status) {
  if (!status) return '';

  // If it has an error, return empty
  if (typeof status === 'object' && status.error) return '';

  // If it's already a string, use it directly (MCP service pre-formatted it)
  if (typeof status === 'string') {
    return status.trim();
  }

  // If object has a formatted/summary field, use that
  if (status.formatted) return String(status.formatted).trim();
  if (status.summary) return String(status.summary).trim();

  // Otherwise, create simple key-value summary of top-level fields
  const parts = [];
  for (const [key, value] of Object.entries(status)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') {
      // For objects/arrays, just show count or type
      if (Array.isArray(value)) {
        if (value.length > 0) parts.push(`${key}: ${value.length} items`);
      } else {
        parts.push(`${key}: {...}`);
      }
    } else {
      // For primitives, show the value
      parts.push(`${key}: ${value}`);
    }
  }
  return parts.join(', ');
}

/**
 * Fetch and format status from ksp://status resource.
 * Returns { statusInfo: string, error: string|null }
 */
async function fetchStatusInfo(client, logPrefix = '') {
  if (!client) return { statusInfo: '', error: undefined };

  const statusData = await readResource(client, 'ksp://status');
  if (!statusData) {
    agentLog(`[agent] ${logPrefix}status: readResource returned nothing`);
    return { statusInfo: '', error: 'no data' };
  }
  if (statusData.error) {
    agentLog(`[agent] ${logPrefix}status error: ${statusData.error}`);
    return { statusInfo: '', error: statusData.error };
  }

  const statusInfo = formatStatusResource(statusData);
  if (!statusInfo) {
    agentLog(`[agent] ${logPrefix}status: formatStatusResource returned empty`);
  }
  return { statusInfo, error: undefined };
}

// Prompt template matching disabled for now
// /**
//  * Format prompt inventory for LLM matching.
//  * Returns text list of available prompts with descriptions.
//  */
// function formatPromptsForMatching(promptInventory) {
//   if (!promptInventory?.length) return '';
//   return promptInventory.map(p => {
//     const parameterList = p.arguments?.map(a => `${a.name}${a.required ? '' : '?'}`).join(', ') || '';
//     return `- ${p.name}(${parameterList}): ${p.description || 'No description'}`;
//   }).join('\n');
// }

// /**
//  * Match user intent to available prompts using LLM.
//  * Returns { matched: true, prompt: string, args: object } or { matched: false }
//  */
// async function matchPromptToIntent(userRequest, promptInventory, agentPrompts) {
//   if (!promptInventory?.length) {
//     return { matched: false };
//   }
//
//   const promptList = formatPromptsForMatching(promptInventory);
//
//   const matchPrompt = `WORKFLOW TEMPLATES:
// ${promptList}
//
// USER REQUEST:
// ${userRequest}
//
// OUTPUT: If a workflow template matches the user's intent, return JSON:
// {"matched": true, "prompt": "template-name", "args": {"arg1": "value1"}}
//
// If no template matches, return:
// {"matched": false}`;
//
//   try {
//     const response = await callOllama(
//       [
//         { role: 'system', content: agentPrompts.role_for_assistant },
//         { role: 'user', content: matchPrompt },
//       ],
//       [],
//       { options: { temperature: 0.3 }, spinnerMessage: 'Preflight: match' },
//     );
//
//     const text = extractAssistantText(response.message).trim();
//     const result = JSON.parse(text);
//     if (result.matched && result.prompt) {
//       return { matched: true, prompt: result.prompt, args: result.args || {} };
//     }
//   } catch {
//     // Parse failed or LLM error, no match
//   }
//   return { matched: false };
// }

/**
 * Send the current conversation + tool definitions to Ollama's /api/chat endpoint.
 * Includes exponential backoff retry logic.
 */
async function callOllama(messages, tools, overrides = {}) {
  return callOllamaWithSignal(messages, tools, undefined, overrides);
}

/**
 * Call Ollama with an optional AbortSignal for timeout support.
 */
async function callOllamaWithSignal(messages, tools, signal, overrides = {}) {
  const maxRetries = Math.max(1, config.maxRetries || 1);
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { options: optionOverrides, silent, spinnerMessage, ...restOverrides } = overrides;
      const body = {
        model: config.model,
        messages,
        tools,
        tool_choice: 'auto',
        stream: false,
        options: {
          num_ctx: config.maxContextTokens ?? 2048,
          //temperature: 0.2,
          //repeat_penalty: 1,
          ...optionOverrides,
        },
        ...restOverrides,
      };

      // Log what we're sending to the LLM (unless silent)
      if (!silent) {
        toLLMLog('[toLLM] ─── Prompt ───');
        for (const message of messages) {
          const content = typeof message.content === 'string'
            ? message.content
            : JSON.stringify(message.content);
          toLLMLog(`[${message.role}]`);
          toLLMLog(content);
          blankLine();
        }
        if (tools?.length) {
          const toolNames = tools.map(t => t.function?.name || t.name);
          toLLMLog(`[tools] ${toolNames.join(', ')}`);
        }
      }

      const fetchOptions = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      };
      if (signal) {
        fetchOptions.signal = signal;
      }

      startSpinner(spinnerMessage || 'Thinking');
      let response;
      try {
        response = await fetch(`${config.ollamaUrl}/api/chat`, fetchOptions);
      } catch (error) {
        stopSpinner();
        throw error;
      }

      if (!response.ok) {
        const text = await response.text();
        throw new Error(
          `Ollama call failed with status ${response.status}: ${text}`,
        );
      }
      const result = await response.json();

      // Log the LLM response (unless silent)
      if (!silent) {
        fromLLMLog('[fromLLM] ─── Response ───');
        const message = result.message;
        if (message) {
          const content = extractAssistantText(message);
          if (content) {
            fromLLMLog(`[content] ${content}`);
          }
          if (message.tool_calls?.length) {
            fromLLMLog(`[tool_calls] ${message.tool_calls.length} call(s):`);
            for (const call of message.tool_calls) {
              const arguments_ = call.function?.arguments;
              const argumentsString = arguments_ && Object.keys(arguments_).length > 0
                ? JSON.stringify(arguments_)
                : '{}';
              fromLLMLog(`  ${call.function?.name}(${argumentsString})`);
            }
          }
        }
      }

      return result;
    } catch (error) {
      // Don't retry on abort
      if (error.name === 'AbortError') {
        throw new Error('Planning step timed out');
      }
      if (attempt === maxRetries) {
        throw error;
      }
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10_000);
      agentWarn(
        `[agent] Ollama call failed, retrying in ${delay}ms (${attempt}/${maxRetries})...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

// Field descriptions for generateAgentPrompts (defined once, used in schema and prompt)
const AGENT_PROMPT_FIELDS = {
  role_for_user: 'A 1-2 sentence greeting describing what you (the assistant) can help with. Written in first person (I can help you...).',
  role_for_assistant: 'A 1-2 sentence mission statement for yourself when selecting and executing tools. Written in first person (I help the user...).',
};

/**
 * Generate dynamic agent prompts based on available tools.
 * Returns { role_for_user, role_for_assistant }
 */
async function generateAgentPrompts(toolInventory, client) {
  const responseSchema = {
    type: 'object',
    properties: {
      role_for_user: {
        type: 'string',
        description: AGENT_PROMPT_FIELDS.role_for_user,
      },
      role_for_assistant: {
        type: 'string',
        description: AGENT_PROMPT_FIELDS.role_for_assistant,
      },
    },
    required: ['role_for_user', 'role_for_assistant'],
  };

  // Build a list of tool names for the prompt
  const toolNames = toolInventory.map(t => t.openAi.function.name).join(', ');

  // Try to get status context from ksp://status resource
  agentLog('[agent] Reading ksp://status resource for intro context...');
  const { statusInfo } = await fetchStatusInfo(client, 'Intro ');
  if (statusInfo) {
    agentLog(`[agent] Status: ${truncateMiddle(statusInfo, 100)}`);
  }

  const response = await callOllama(
    [
      {
        role: 'user',
        content: `TOOLS: ${toolNames}

STATUS:
${statusInfo || 'No status available.'}

TASK: Write two 1-2 sentence summaries in these forms:

{
  "role_for_user": "I can help [describe what you can accomplish with these TOOLS considering STATUS]...",
  "role_for_assistant": "You are a helpful assistant specializing in [describe what you can accomplish with these tools]..."
}

OUTPUT: JSON object with role_for_user and role_for_assistant fields.`,
      },
    ],
    [], // No tools - we just want a JSON response
    { format: responseSchema, spinnerMessage: 'Initializing' },
  );

  const text = extractAssistantText(response.message);
  if (!text || text.trim() === '') {
    agentLog('[agent] Debug - raw response:', JSON.stringify(response.message, undefined, 2));
    throw new Error('LLM returned empty response for agent prompts');
  }
  return JSON.parse(text);
}

/**
 * Get tier 1 and 2 tools (common tools for planning).
 */
function getCommonTools(toolInventory) {
  return toolInventory.filter((t) => (t.tier ?? 2) <= 2);
}

/**
 * Get tier 3+ tools (specialized tools).
 */
function getOtherTools(toolInventory) {
  return toolInventory.filter((t) => (t.tier ?? 2) > 2);
}

/**
 * Format tool list by tier - tier 1&2 get descriptions, others just names.
 */
function formatToolsByTier(toolInventory) {
  const tier1and2 = getCommonTools(toolInventory);
  const otherTools = getOtherTools(toolInventory);

  const lines = [];

  if (tier1and2.length > 0) {
    for (const t of tier1and2) {
      lines.push(`- ${t.openAi.function.name}: ${t.openAi.function.description || 'No description'}`);
    }
  }

  if (otherTools.length > 0) {
    const otherNames = otherTools.map((t) => t.openAi.function.name).join(', ');
    lines.push(`- Other tools: ${otherNames}`);
  }

  return lines.join('\n');
}

/**
 * Parse LLM planning response into structured result.
 * Returns: { type: 'undefined' } | { type: 'empty' } | { type: 'tools', tools: string[] }
 */
function parsePlannedToolsResponse(text, toolInventory) {
  if (!text) {
    return { type: 'empty' };
  }

  const trimmed = text.trim().toLowerCase();

  // Check for explicit "undefined" or "null" response (needs full tool list)
  if (trimmed === 'undefined' || trimmed === 'null') {
    return { type: 'undefined' };
  }

  const availableNames = toolInventory.map(
    (entry) => entry.openAi.function.name,
  );
  const lowerNameMap = new Map(
    availableNames.map((name) => [name.toLowerCase(), name]),
  );

  // Helper: find best matching tool name (exact, then prefix, then word-boundary, then fuzzy)
  function findToolMatch(input) {
    const lower = input.toLowerCase().replaceAll(/[\s-]/g, '_');

    // Exact match
    if (lowerNameMap.has(lower)) {
      return lowerNameMap.get(lower);
    }
    // Prefix match (e.g., "hohmann" matches "hohmann_transfer")
    for (const [key, value] of lowerNameMap) {
      if (key.startsWith(lower) || lower.startsWith(key)) {
        return value;
      }
    }
    // Word-boundary match: input must match a complete fragment (exact)
    for (const [key, value] of lowerNameMap) {
      const fragments = key.split('_');
      if (fragments.includes(lower)) {
        return value;
      }
    }
    // Fuzzy match: allow single character typo (edit distance of 1)
    for (const [key, value] of lowerNameMap) {
      if (levenshteinDistance(lower, key) === 1) {
        return value;
      }
    }
    return;
  }

  // Try JSON parsing first
  try {
    const parsed = JSON.parse(text);

    // Handle JSON array: ["set_target", "hohmann_transfer"]
    if (Array.isArray(parsed)) {
      // Empty array is explicit "no tools needed"
      if (parsed.length === 0) {
        return { type: 'empty' };
      }
      const sequence = [];
      for (const item of parsed) {
        const name = String(item).trim();
        const match = findToolMatch(name);
        if (match && !sequence.includes(match)) {
          sequence.push(match);
        }
      }
      if (sequence.length > 0) {
        return { type: 'tools', tools: sequence };
      }
    }

    // Handle JSON object with "tools" key: {"tools": ["set_target", ...]}
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.tools)) {
      if (parsed.tools.length === 0) {
        return { type: 'empty' };
      }
      const sequence = [];
      for (const item of parsed.tools) {
        const name = String(item).trim();
        const match = findToolMatch(name);
        if (match && !sequence.includes(match)) {
          sequence.push(match);
        }
      }
      if (sequence.length > 0) {
        return { type: 'tools', tools: sequence };
      }
    }

    // Handle JSON object with tool names as keys: {"set_target": [], "hohmann_transfer": []}
    // Only use if there are 1-10 keys (not the full catalog)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const keys = Object.keys(parsed);
      if (keys.length > 0 && keys.length <= 10) {
        const sequence = [];
        for (const key of keys) {
          const match = findToolMatch(key);
          if (match && !sequence.includes(match)) {
            sequence.push(match);
          }
        }
        if (sequence.length > 0) {
          return { type: 'tools', tools: sequence };
        }
      }
    }
  } catch {
    // Fall through to comma parsing
  }

  // Also try finding array within text
  const jsonMatch = text.match(/\[[\s\S]*?\]/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed)) {
        if (parsed.length === 0) {
          return { type: 'empty' };
        }
        const sequence = [];
        for (const item of parsed) {
          const name = String(item).trim();
          const match = findToolMatch(name);
          if (match && !sequence.includes(match)) {
            sequence.push(match);
          }
        }
        if (sequence.length > 0) {
          return { type: 'tools', tools: sequence };
        }
      }
    } catch {
      // Fall through
    }
  }

  // Fallback: comma/newline separated
  const tokens = text
    .split(/[\n,;]+/)
    .map((token) =>
      token
        .replace(/^[\d.\-\s[\]"']+/, '')
        .replace(/[[\]"']+$/, '')
        .trim(),
    )
    .filter(Boolean);

  const sequence = [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower === 'none' || lower === '[]') {
      return { type: 'empty' };
    }

    // Use fuzzy matching
    const match = findToolMatch(token);
    if (match && !sequence.includes(match)) {
      sequence.push(match);
    }
  }

  if (sequence.length > 0) {
    return { type: 'tools', tools: sequence };
  }

  // No valid tools parsed
  return { type: 'empty' };
}

/**
 * Run a single planning query with specified temperature.
 * Returns structured result: { type: 'undefined' | 'empty' | 'tools', tools?: string[] }
 */
async function runPlanningQuery(planningMessages, toolInventory, temperature = 0.8) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await callOllamaWithSignal(
      planningMessages,
      [],
      controller.signal,
      {
        // Allow string for "undefined" response, or array for tools
        options: { temperature },
        silent: true, // Prompt logged once before parallel queries
        spinnerMessage: 'Planning: tools',
      },
    );
    clearTimeout(timeoutId);

    const planText = extractAssistantText(response.message).trim();
    return parsePlannedToolsResponse(planText, toolInventory);
  } catch {
    clearTimeout(timeoutId);
    return { type: 'empty' };
  }
}

/**
 * Compute consensus tools from multiple structured planning results.
 * Results are { type: 'undefined' | 'empty' | 'tools', tools?: string[] }
 * Returns { tools: string[], undefinedCount: number, emptyCount: number }
 */
function computeConsensusTools(results, threshold = 3) {
  const undefinedCount = results.filter((r) => r.type === 'undefined').length;
  const emptyCount = results.filter((r) => r.type === 'empty').length;

  // Extract tool arrays from results that have tools
  const toolResults = results
    .filter((r) => r.type === 'tools' && r.tools?.length > 0)
    .map((r) => r.tools);

  if (toolResults.length === 0) {
    return { tools: [], undefinedCount, emptyCount };
  }

  // Count occurrences of each tool across all tool results
  const counts = new Map();
  for (const toolList of toolResults) {
    for (const tool of toolList) {
      counts.set(tool, (counts.get(tool) || 0) + 1);
    }
  }

  // Find tools that meet threshold (or majority fallback)
  const effectiveThreshold = Math.min(threshold, toolResults.length);
  let consensusSet = [...counts.entries()]
    .filter(([, count]) => count >= effectiveThreshold)
    .map(([tool]) => tool);

  // Fallback to majority (2+) if strict threshold yields nothing
  if (consensusSet.length === 0 && effectiveThreshold > 2) {
    consensusSet = [...counts.entries()]
      .filter(([, count]) => count >= 2)
      .map(([tool]) => tool);
  }

  // Use order from the result that contains the most consensus tools
  let consensus = [];
  if (consensusSet.length > 0) {
    let bestResult = [];
    let bestOverlap = 0;
    for (const result of toolResults) {
      const overlap = result.filter(t => consensusSet.includes(t)).length;
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestResult = result;
      }
    }
    // Extract consensus tools in the order they appear in bestResult
    consensus = bestResult.filter(t => consensusSet.includes(t));
  }

  // Check for order disagreement among results with the consensus tools
  const orderDisagreement = hasOrderDisagreement(toolResults, consensus);

  return { tools: consensus, undefinedCount, emptyCount, orderDisagreement };
}

/**
 * Check if tool results have different orderings of the same consensus tools.
 */
function hasOrderDisagreement(toolResults, consensusTools) {
  if (consensusTools.length < 2) return false;

  // Get the order of consensus tools from each result
  const orders = toolResults
    .map(tools => tools.filter(t => consensusTools.includes(t)))
    .filter(filtered => filtered.length === consensusTools.length);

  if (orders.length < 2) return false;

  // Compare orders - if any differ, there's disagreement
  const firstOrder = orders[0].join(',');
  return orders.some(order => order.join(',') !== firstOrder);
}

/**
 * Specialized helper called by planToolSequence when consensus tools have
 * different orderings across queries. Runs a single LLM query specifically
 * to resolve the optimal execution order.
 */
async function runOrderingQuery(consensusTools, userPrompt, toolInventory, agentPrompts) {
  const toolDescriptions = consensusTools.map(name => {
    const entry = findToolEntry(toolInventory, name);
    const desc = entry?.openAi.function.description || 'No description';
    return `- ${name}: ${desc}`;
  }).join('\n');

  const orderingSystem = `${agentPrompts.role_for_assistant}

TASK: Order these tools to fulfill the user's request.

TOOLS TO ORDER:
${toolDescriptions}`;

  agentLog('[agent] Running ordering query to resolve order disagreement...');

  const response = await callOllama(
    [
      { role: 'system', content: orderingSystem },
      { role: 'user', content: userPrompt },
      { role: 'system', content: 'OUTPUT: Return tool names as a JSON array in execution order, e.g. ["first_tool", "second_tool"]' },
    ],
    [],
    { options: { temperature: 0.3 }, spinnerMessage: 'Planning: order' },
  );

  const text = extractAssistantText(response.message).trim();
  const parsed = parsePlannedToolsResponse(text, toolInventory);

  if (parsed.type === 'tools' && parsed.tools?.length > 0) {
    // Only return tools that are in the consensus set
    const orderedTools = parsed.tools.filter(t => consensusTools.includes(t));
    if (orderedTools.length === consensusTools.length) {
      return orderedTools;
    }
  }

  // Fallback to original consensus order
  agentLog('[agent] Ordering query did not resolve; using original order.');
  return consensusTools;
}

/**
 * Build planning messages with all tools catalog.
 */
function buildPlanningMessages(userPrompt, toolInventory, historySummary, agentPrompts, promptGuidance = '', statusInfo = '') {
  const historySection = historySummary || 'This is the initial prompt.';
  const toolsText = formatToolsByTier(toolInventory);

  // Include status if available
  const statusSection = statusInfo
    ? `\n\nSTATUS:\n${statusInfo}`
    : '';

  // Include prompt guidance if available
  const guidanceSection = promptGuidance
    ? `\n\nWORKFLOW GUIDANCE:\n${promptGuidance}`
    : '';

  const combinedPlanningPrompt = `${agentPrompts.role_for_assistant}

Select tools from TOOLS to fulfill the user request.

RULES:
1. Map user intent to tools (e.g., "go to X" → transfer tools, "fix orbit" → circularize).
2. Pick the smallest set of tools needed.
3. Use exact tool names - NO invented names.
4. Return tools in execution order.
5. Return empty array ONLY for greetings or questions.
6. Do not repeat tools from HISTORY for the same purpose.`;

  return [
    {
      role: 'system',
      content: `${combinedPlanningPrompt}\n\nTOOLS:\n${toolsText}${statusSection}\n\nHISTORY:\n${historySection}${guidanceSection}`,
    },
    {
      role: 'user',
      content: userPrompt,
    },
    {
      role: 'system',
      content: 'OUTPUT: ["tool_name"] or ["first_tool", "second_tool"]',
    },
  ];
}

/**
 * Orchestrates tool sequence planning by running 3 parallel LLM queries
 * at different temperatures (0.5, 0.8, 1.1) and computing consensus.
 * Handles order disagreement detection by calling runOrderingQuery when needed.
 */
async function planToolSequence(userPrompt, toolInventory, historySummary = '', agentPrompts, promptGuidance = '', statusInfo = '') {
  agentLog('[agent] Planning tool sequence (consensus mode)...');
  if (!userPrompt || !userPrompt.trim()) {
    return { sequence: [], needsAltIntro: false };
  }

  // Log tool counts
  const commonTools = getCommonTools(toolInventory);
  const otherTools = getOtherTools(toolInventory);
  agentLog(`[agent] Tools: ${commonTools.length} common, ${otherTools.length} other`);

  const planningMessages = buildPlanningMessages(
    userPrompt,
    toolInventory,
    historySummary,
    agentPrompts,
    promptGuidance,
    statusInfo,
  );

  // Log the planning prompt once (before parallel queries)
  toLLMLog('[toLLM] ─── Planning Prompt ───');
  for (const message of planningMessages) {
    if (message.role === 'system') {
      toLLMLog('[system]');
    }
    toLLMLog(message.content);
    blankLine();
  }

  const PLANNING_TEMPERATURES = [0.5, 0.8, 1.1];

  try {
    agentLog(
      `[agent] Running ${PLANNING_TEMPERATURES.length} planning queries for consensus...`,
    );

    const queryPromises = PLANNING_TEMPERATURES.map((temperature) =>
      runPlanningQuery(planningMessages, toolInventory, temperature),
    );

    let results = await Promise.all(queryPromises);

    // Log individual results for debugging
    for (const [index, r] of results.entries()) {
      const toolsText = r.type === 'tools' && r.tools?.length > 0
        ? r.tools.join(', ')
        : `(${r.type})`;
      agentLog(
        `[agent] Query ${index + 1} (temp=${PLANNING_TEMPERATURES[index]}): ${toolsText}`,
      );
    }

    // Compute consensus and check for special conditions
    const consensus = computeConsensusTools(results, PLANNING_TEMPERATURES.length);

    // If order disagreement detected, run ordering query to resolve
    if (consensus.orderDisagreement && consensus.tools.length >= 2) {
      const orderedTools = await runOrderingQuery(
        consensus.tools,
        userPrompt,
        toolInventory,
        agentPrompts,
      );
      agentLog(`[agent] Ordered tools: ${orderedTools.join(' -> ')}`);
      consensus.tools = orderedTools;
    }

    // If 2+ agents return empty, signal alt_intro needed
    if (consensus.emptyCount >= 2) {
      agentLog('[agent] Planning consensus: no tools determined (2+ empty). Needs alt_intro.');
      return { sequence: [], needsAltIntro: true };
    }

    const sequence = consensus.tools;
    agentLog(`[agent] Consensus tools: ${sequence.join(', ') || '(none)'}`);

    // Validate and dedupe tools
    const seen = new Set();
    const validSequence = sequence.filter((name) => {
      if (seen.has(name)) return false;
      if (!findToolEntry(toolInventory, name)) return false;
      seen.add(name);
      return true;
    });

    // Sanity checks
    if (validSequence.length > MAX_SEQUENTIAL_PLAN_LENGTH) {
      agentWarn(
        `[agent] Planning returned ${validSequence.length} tools (exceeds limit of ${MAX_SEQUENTIAL_PLAN_LENGTH}). Needs alt_intro.`,
      );
      return { sequence: [], needsAltIntro: true };
    }

    if (validSequence.length > 0) {
      agentLog(`[agent] Planned tool order: ${validSequence.join(' -> ')}`);
    } else {
      agentLog('[agent] Planning step returned no tools.');
    }

    return { sequence: validSequence, needsAltIntro: validSequence.length === 0 };
  } catch (error) {
    agentWarn(`[agent] Planning step failed: ${describeError(error)}`);
    return { sequence: [], needsAltIntro: true };
  }
}

function normalizeStructuredStatus(status) {
  if (status === null || status === undefined) {
    return '';
  }
  return String(status).trim().toLowerCase();
}

function didToolSucceed(result) {
  if (!result || typeof result !== 'object') {
    return false;
  }
  if (result.isError) {
    return false;
  }
  const structuredStatus = normalizeStructuredStatus(
    result.structuredContent?.status,
  );
  if (structuredStatus === 'success') {
    return true;
  }
  if (structuredStatus === 'error') {
    return false;
  }
  return true;
}

function formatStructuredValue(value) {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? `${value}` : String(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => formatStructuredValue(item)).join(', ');
  }
  return JSON.stringify(value);
}

function buildStructuredSummaryLine(structuredContent) {
  if (!structuredContent || typeof structuredContent !== 'object') {
    return '';
  }
  const status = normalizeStructuredStatus(structuredContent.status);
  const action = structuredContent.action
    ? String(structuredContent.action)
    : '';
  const detailEntries = Object.entries(structuredContent)
    .filter(
      ([key, value]) =>
        key !== 'status' && key !== 'action' && value !== undefined,
    )
    .map(([key, value]) => `${key}=${formatStructuredValue(value)}`);
  const headlineParts = [];
  if (action) {
    headlineParts.push(action);
  }
  if (status) {
    headlineParts.push(status);
  }
  const headline = headlineParts.join(' - ');
  if (!headline && detailEntries.length === 0) {
    return '';
  }
  if (detailEntries.length === 0) {
    return headline;
  }
  return headline
    ? `${headline}: ${detailEntries.join(', ')}`
    : detailEntries.join(', ');
}

function formatMcpResult(result) {
  const segments = [];

  const structuredSummary = buildStructuredSummaryLine(
    result.structuredContent,
  );
  if (result.isError && !structuredSummary) {
    segments.push('ERROR');
  }
  if (structuredSummary) {
    segments.push(structuredSummary);
  }

  if (Array.isArray(result.content)) {
    for (const entry of result.content) {
      switch (entry.type) {
      case 'text': {
        segments.push(sanitizeToolText(entry.text));
      
      break;
      }
      case 'json': {
        segments.push(JSON.stringify(entry.data, undefined, 2));
      
      break;
      }
      case 'resource': {
        segments.push(
          `resource(${entry.resource?.uri ?? 'unknown'}): ${entry.resource?.text ?? ''
          }`,
        );
      
      break;
      }
      default: {
        segments.push(`[${entry.type}] ${JSON.stringify(entry)}`);
      }
      }
    }
  }

  if (segments.length === 0) {
    segments.push('(no content)');
  }

  const combined = sanitizeToolText(segments.join('\n'));
  return removeScriptNoise(combined, result.isError);
}

function safeParseArguments(rawArguments) {
  if (!rawArguments || Object.keys(rawArguments).length === 0) {
    return {};
  }

  if (typeof rawArguments === 'string') {
    try {
      return rawArguments.length > 0 ? JSON.parse(rawArguments) : {};
    } catch {
      throw new Error(`Tool arguments are not valid JSON: ${rawArguments}`);
    }
  }

  return rawArguments;
}

function findToolEntry(toolInventory, toolName) {
  return toolInventory.find(
    (entry) => entry.openAi.function.name === toolName,
  );
}

function normalizeArgumentsForEntry(entry, rawArguments) {
  if (!rawArguments || typeof rawArguments !== 'object') {
    return {};
  }

  const allowedKeys = entry?.parameterKeys ?? [];
  const normalized = {};
  for (const [key, value] of Object.entries(rawArguments)) {
    if (!allowedKeys.includes(key)) {
      continue;
    }
    if (value === null || value === undefined || value === '') {
      continue;
    }
    if (
      typeof value === 'string' &&
      ['null', 'undefined', 'none'].includes(value.trim().toLowerCase())
    ) {
      continue;
    }
    if (key === 'cpuId') {
      const cleanedId = sanitizeCpuId(value);
      if (cleanedId === undefined || cleanedId === null) {
        continue;
      }
      normalized[key] = cleanedId;
      continue;
    }
    if (key === 'cpuLabel') {
      const cleanedLabel = sanitizeCpuLabel(value);
      if (!cleanedLabel) {
        continue;
      }
      normalized[key] = cleanedLabel;
      continue;
    }
    normalized[key] = coercePrimitive(value);
  }

  return normalized;
}

function coercePrimitive(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const lower = trimmed.toLowerCase();
    if (lower === 'true') {
      return true;
    }
    if (lower === 'false') {
      return false;
    }

    const numeric = Number(trimmed);
    if (!Number.isNaN(numeric) && trimmed !== '') {
      return numeric;
    }
    return trimmed;
  }
  return value;
}

function formatParameterHints(tool) {
  const parameters = tool.parameters?.properties ?? {};
  const required = tool.parameters?.required ?? [];

  if (Object.keys(parameters).length === 0) return '';

  return Object.entries(parameters).map(([key, schema]) => {
    const requiredMark = required.includes(key) ? ' (required)' : '';
    const type = schema.type || 'string';
    const desc = schema.description ? ` - ${schema.description}` : '';
    return `  - ${key}: ${type}${requiredMark}${desc}`;
  }).join('\n');
}

function buildFocusedToolPrompt(
  userQuery,
  toolEntry,
  previousResult,
  nextTool,
  step,
  total,
  agentPrompts,
) {
  const tool = toolEntry.openAi.function;
  const parameterHints = formatParameterHints(tool);

  // Build system message with role, rules, task, and tool info
  const systemLines = [
    agentPrompts.role_for_assistant,
    '',
    SINGLE_TOOL_RULES,
    '',
    `TASK: Step ${step}/${total} - Call "${tool.name}"`,
    '',
    `TOOL: ${tool.name}`,
    tool.description,
  ];

  if (parameterHints) {
    systemLines.push(
      '',
      'PARAMETERS:',
      parameterHints,
    );
  }

  // Add context about previous/next steps if available
  if (previousResult || nextTool) {
    systemLines.push('', 'CONTEXT:');
    if (previousResult) {
      systemLines.push(`- Previous step: ${previousResult.tool} → ${previousResult.result}`);
    }
    if (nextTool) {
      systemLines.push(`- Next step: ${nextTool}`);
    }
  }

  systemLines.push('', 'USER REQUEST:');

  return {
    system: systemLines.join('\n'),
    user: userQuery,
  };
}

function buildToolRetryPrompt(
  userQuery,
  toolEntry,
  errorMessage,
  attempt,
  maxAttempts,
  step,
  total,
  agentPrompts,
) {
  const tool = toolEntry.openAi.function;
  const parameterHints = formatParameterHints(tool);

  // Build system message with role, rules, task, and tool info
  const systemLines = [
    agentPrompts.role_for_assistant,
    '',
    SINGLE_TOOL_RULES,
    '',
    `TASK: Step ${step}/${total} - Call "${tool.name}"`,
    `ATTEMPT: ${attempt} of ${maxAttempts}`,
    '',
    `TOOL: ${tool.name}`,
    tool.description,
  ];

  if (parameterHints) {
    systemLines.push(
      '',
      'PARAMETERS:',
      parameterHints,
    );
  }

  systemLines.push(
    '',
    'PREVIOUS ERROR:',
    errorMessage,
    '',
    'USER REQUEST:',
  );

  return {
    system: systemLines.join('\n'),
    user: userQuery,
  };
}

function buildSummaryPrompt(userQuery, toolEvents) {
  const lines = [
    'USER REQUEST:',
    userQuery,
    '',
    'RESULTS:',
  ];

  for (const [index, event] of toolEvents.entries()) {
    const status = event.success ? '✓' : '✗';
    lines.push(`${index + 1}. ${event.name} ${status}: ${event.summary}`);
  }

  lines.push(
    '',
    'INSTRUCTIONS:',
    '1. Summarize ONLY what the RESULTS show was accomplished.',
    '2. Do NOT suggest actions or next steps not shown in RESULTS.',
    '3. If a tool failed, report the error.',
    '4. Ask what the user wants to do next.',
    '',
    'Keep response under 50 words.',
  );

  return lines.join('\n');
}

function summarizeHistory(history, limit) {
  if (history.length === 0) {
    return '';
  }
  const toShow = history.slice(-limit);
  const truncated = history.length - toShow.length;
  const lines = [];
  const header =
    truncated > 0
      ? `History: last ${toShow.length}/${history.length} (older ${truncated} hidden)`
      : `History: last ${toShow.length}`;
  lines.push(header);
  for (const [index, entry] of toShow.entries()) {
    const absoluteIndex = history.length - toShow.length + index + 1;
    lines.push(
      `${absoluteIndex}. ${truncateMiddle(
        entry.prompt,
        HISTORY_PROMPT_TEXT_LIMIT,
      )}`,
    );
    const toolText = entry.toolEvents?.length
      ? entry.toolEvents
          .map((event) => `${event.name}${event.success ? '✅' : '❌'}`)
          .join('; ')
      : 'none';
    lines.push(`   tools: ${toolText}`);
    const finalSummary = truncateMiddle(
      entry.finalSummary,
      HISTORY_RESULT_TEXT_LIMIT,
    );
    if (finalSummary && finalSummary.length > 0) {
      lines.push(`   result: ${finalSummary}`);
    }
  }
  return lines.join('\n');
}

/**
 * Truncate text by removing characters from the middle.
 * Preserves context at both start and end of text.
 */
function truncateMiddle(text, limit) {
  if (!text || text.length <= limit) return text || '';

  // Keep ~60% at start, ~40% at end (front-weighted for context)
  const startLength = Math.floor(limit * 0.6);
  const endLength = limit - startLength - 5; // 5 for " ... "

  const start = text.slice(0, startLength);
  const end = text.slice(-endLength);
  return `${start} ... ${end}`;
}

function flattenWhitespace(text) {
  return text ? text.replaceAll(/\s+/g, ' ').trim() : '';
}

function extractAssistantText(message) {
  if (!message) {
    return '';
  }
  if (typeof message.content === 'string') {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    return message.content
      .filter((entry) => entry && typeof entry.text === 'string')
      .map((entry) => entry.text)
      .join('\n');
  }
  return '';
}

function levenshteinDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix = [];
  for (let index = 0; index <= b.length; index++) {
    matrix[index] = [index];
  }
  for (let index = 0; index <= a.length; index++) {
    matrix[0][index] = index;
  }

  for (let index = 1; index <= b.length; index++) {
    for (let index_ = 1; index_ <= a.length; index_++) {
      matrix[index][index_] = b.charAt(index - 1) === a.charAt(index_ - 1) ? matrix[index - 1][index_ - 1] : Math.min(
          matrix[index - 1][index_ - 1] + 1,
          matrix[index][index_ - 1] + 1,
          matrix[index - 1][index_] + 1
        );
    }
  }
  return matrix[b.length][a.length];
}

function sanitizeToolText(text) {
  if (!text) {
    return '(no output)';
  }
  const cleaned = text
    // eslint-disable-next-line no-control-regex -- intentionally removing control chars
    .replaceAll(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replaceAll(/\r\n?/g, '\n')
    .replaceAll(/[ \t]+\n/g, '\n')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned.length > 0 ? cleaned : '(no output)';
}

function sanitizeCpuId(value) {
  if (value === null || value === undefined) {
    return;
  }
  const numeric =
    typeof value === 'number' ? value : Number(String(value).trim());
  if (Number.isNaN(numeric)) {
    return;
  }
  const integer = Math.floor(numeric);
  return integer >= 0 ? integer : undefined;
}

function sanitizeCpuLabel(value) {
  if (value === null || value === undefined) {
    return '';
  }
  const raw = String(value).trim();
  if (!raw) {
    return '';
  }
  const lower = raw.toLowerCase();
  if (['default', 'auto', 'automatic', 'first', 'any', 'none'].includes(lower)) {
    return '';
  }
  const match = raw.match(/\(([^)]+)\)/);
  if (match && match[1]) {
    return match[1].trim();
  }
  return raw;
}

function removeScriptNoise(text, isError) {
  if (isError) {
    return text;
  }
  const scriptPrefixes = [
    'PRINT',
    'SET',
    'UNTIL',
    'IF ',
    'ELSEIF',
    'ELSE',
    'LOCK',
    'WHEN',
    'ON ',
    'RUN',
    'DECLARE',
  ];
  const lines = text.split('\n');
  const filtered = lines.filter((line) => {
    const trimmed = line.trimStart();
    if (!trimmed) {
      return true;
    }
    return !scriptPrefixes.some((prefix) =>
      trimmed.toUpperCase().startsWith(prefix),
    );
  });
  const cleaned = filtered.join('\n').trim();
  return cleaned.length > 0 ? cleaned : text;
}

/**
 * Sequential tool execution - forces each tool in sequence with focused prompts.
 * Each tool gets its own Ollama call with only that tool available.
 */
async function runSequentialToolExecution(
  userPrompt,
  toolSequence,
  toolInventory,
  client,
  agentPrompts,
) {
  const toolEvents = [];
  let previousResult;

  for (let index = 0; index < toolSequence.length; index++) {
    const toolName = toolSequence[index];
    const toolEntry = findToolEntry(toolInventory, toolName);
    if (!toolEntry) {
      agentWarn(`[agent] Tool "${toolName}" not found in inventory, skipping.`);
      continue;
    }

    const nextTool = index < toolSequence.length - 1 ? toolSequence[index + 1] : undefined;

    // Build focused single-tool prompt
    const focusedPrompt = buildFocusedToolPrompt(
      userPrompt,
      toolEntry,
      previousResult,
      nextTool,
      index + 1,
      toolSequence.length,
      agentPrompts,
    );

    agentLog(
      `[agent] Step ${index + 1}/${toolSequence.length}: Calling ${toolName}...`,
    );

    // Call Ollama with ONLY this one tool - retry once if model doesn't call it
    let arguments_ = {};
    let attempts = 0;
    const maxAttempts = 2;

    while (attempts < maxAttempts) {
      attempts++;
      const systemToUse = attempts === 1
        ? focusedPrompt.system
        : `You MUST call the "${toolName}" tool NOW. This is required.\n\n${focusedPrompt.system}`;

      const response = await callOllama(
        [
          { role: 'system', content: systemToUse },
          { role: 'user', content: focusedPrompt.user },
        ],
        [toolEntry.openAi],
        { format: 'json', spinnerMessage: `Step ${index + 1}: ${toolName}` },
      );

      const toolCalls = response.message?.tool_calls ?? [];

      if (toolCalls.length > 0) {
        const call = toolCalls[0];
        arguments_ = normalizeArgumentsForEntry(
          toolEntry,
          safeParseArguments(call.function?.arguments),
        );
        break;
      }

      if (attempts < maxAttempts) {
        agentWarn(`[agent] Model didn't call ${toolName}. Retrying with stronger prompt...`);
      } else {
        agentWarn(`[agent] Model didn't call ${toolName} after ${maxAttempts} attempts. Using empty args.`);
      }
    }

    // Tool execution with retry on error
    const maxToolAttempts = 2;
    let toolSucceeded = false;

    for (let toolAttempt = 1; toolAttempt <= maxToolAttempts; toolAttempt++) {
      toToolLog(toolName, Object.keys(arguments_).length > 0 ? JSON.stringify(arguments_) : '(no args)');

      try {
        const progressToken = randomUUID();
        const result = await client.callTool(
          { name: toolName, arguments: arguments_, _meta: { progressToken } },
          undefined,
          {
            timeout: config.toolTimeout,
            resetTimeoutOnProgress: true,
            onprogress: (progress) => {
              if (progress.message) {
                updateSpinner(progress.message);
              }
            },
          }
        );
        const textResult = formatMcpResult(result);
        fromToolLog(toolName, textResult.split('\n')[0]);
        say(textResult.split('\n')[0]);
        if (textResult.includes('\n')) {
          for (const line of textResult.split('\n').slice(1)) {
            if (line.trim()) fromToolLog(toolName, `  ${line}`);
          }
        }

        const success = didToolSucceed(result);
        toolEvents.push({
          name: toolName,
          success,
          summary: truncateMiddle(textResult, HISTORY_EVENT_TEXT_LIMIT),
        });

        previousResult = { tool: toolName, result: textResult };
        toolSucceeded = success;

        if (!success) {
          agentWarn(`[agent] Tool ${toolName} failed. Stopping sequence.`);
          // Log raw result for debugging
          if (result.structuredContent) {
            agentWarn(`[agent] Structured: ${JSON.stringify(result.structuredContent)}`);
          }
        }
        break; // Exit retry loop on successful call (even if tool reports failure)
      } catch (error) {
        const message = describeError(error);

        if (toolAttempt < maxToolAttempts) {
          agentWarn(`[agent] Tool ${toolName} threw error: ${message}. Retrying...`);

          // Build retry prompt with error info
          const retryPrompt = buildToolRetryPrompt(
            userPrompt,
            toolEntry,
            message,
            toolAttempt + 1,
            maxToolAttempts,
            index + 1,
            toolSequence.length,
            agentPrompts,
          );

          // Call LLM again to get new arguments
          const retryResponse = await callOllama(
            [
              { role: 'system', content: retryPrompt.system },
              { role: 'user', content: retryPrompt.user },
            ],
            [toolEntry.openAi],
            { format: 'json', spinnerMessage: `Step ${index + 1}: ${toolName} (retry)` },
          );

          const retryToolCalls = retryResponse.message?.tool_calls ?? [];
          if (retryToolCalls.length > 0) {
            arguments_ = normalizeArgumentsForEntry(
              toolEntry,
              safeParseArguments(retryToolCalls[0].function?.arguments),
            );
          }
          continue;
        }

        // Final attempt failed
        agentError(`[agent] Tool ${toolName} threw error: ${message}`);
        toolEvents.push({
          name: toolName,
          success: false,
          summary: truncateMiddle(message, HISTORY_EVENT_TEXT_LIMIT),
        });
      }
    }

    if (!toolSucceeded) {
      break; // Exit main tool sequence loop
    }
  }

  return { toolEvents };
}

/**
 * Preflight check: expand user request AND check for matching prompt templates.
 * Returns { expandedRequest, promptGuidance }
 */
async function runPreflightCheck(userRequest, previousAssistantResponse, toolInventory, promptInventory, client, agentPrompts) {
  let expandedRequest = userRequest;
  let promptGuidance = '';

  // 1. Expand requests that may reference previous response
  agentLog('[agent] Running preflight expansion...');

  // Get tier 1 and 2 tool names for context
  const commonToolNames = getCommonTools(toolInventory)
    .map(t => t.openAi.function.name)
    .join(', ');

  // Get current status
  const { statusInfo } = await fetchStatusInfo(client, 'Preflight ');
  const statusSection = statusInfo ? `\nSTATUS:\n${statusInfo}\n` : '';

  const preflightSystem = `${agentPrompts.role_for_assistant}

TOOLS: ${commonToolNames}
${statusSection}
CONTEXT (for reference only):
${previousAssistantResponse}

TASK: Rewrite the user input as a complete, self-contained request.
- If the input references the context (e.g., "yes", "do it", "the first one"), incorporate the relevant details.
- If the input is already complete, return it unchanged.
- Replace invalid names with valid names from TOOLS or STATUS. User STT may mangle proper nouns.
- NEVER return the CONTEXT itself.`;

  const response = await callOllama(
    [
      { role: 'system', content: preflightSystem },
      { role: 'user', content: userRequest },
      { role: 'system', content: 'OUTPUT:' },
    ],
    [],
    { options: { temperature: 0.3 }, spinnerMessage: 'Preflight: expand' },
  );

  const expanded = extractAssistantText(response.message).trim();

  // If LLM returned something meaningful and different, use it
  if (expanded && expanded.length > 0 && expanded !== userRequest) {
    agentLog(`[agent] Preflight expanded: "${expanded}"`);
    expandedRequest = expanded;
  }

  // 2. Prompt template matching disabled for now
  // const promptMatch = await matchPromptToIntent(expandedRequest, promptInventory, agentPrompts);
  // if (promptMatch.matched) {
  //   agentLog(`[agent] Matched prompt template: ${promptMatch.prompt}`);
  //   try {
  //     const { messages } = await client.getPrompt(promptMatch.prompt, promptMatch.args);
  //     promptGuidance = messages[0]?.content?.text || '';
  //     if (promptGuidance) {
  //       agentLog(`[agent] Prompt guidance: ${truncateMiddle(promptGuidance, 100)}`);
  //     }
  //   } catch (error) {
  //     const message = error instanceof Error ? error.message : String(error);
  //     agentWarn(`[agent] Failed to get prompt: ${message}`);
  //   }
  // }

  return { expandedRequest, promptGuidance };
}

/**
 * Alt-intro process: when planning returns no tools, get context and prompt user.
 * Returns LLM's response (either a direct answer or a clarifying question).
 */
async function runAltIntroProcess(
  userPrompt,
  toolInventory,
  history,
  agentPrompts,
  client,
) {
  agentLog('[agent] Running alt_intro process...');

  // 1. Try to get status from ksp://status resource
  const { statusInfo } = await fetchStatusInfo(client, 'Alt-intro ');
  if (statusInfo) {
    agentLog(`[agent] Status: ${truncateMiddle(statusInfo, 100)}`);
  }

  // 2. Build the alt-intro prompt for the LLM
  const historySummary = summarizeHistory(history, HISTORY_MAX_PROMPTS);
  const commonToolNames = getCommonTools(toolInventory)
    .map(t => t.openAi.function.name)
    .join(', ');

  const altIntroPrompt = `${agentPrompts.role_for_assistant}

The planning stage could not determine which tools to use for this request.

TOOLS: ${commonToolNames}

CONTEXT:
${statusInfo ? `Current status: ${statusInfo}` : 'No status available.'}
${historySummary || 'This is the initial prompt.'}

USER REQUEST:
${userPrompt}

OUTPUT: Ask ONE short clarifying question to understand which tool(s) would help.`;

  // 3. Call LLM to generate response
  toLLMLog('[toLLM] ─── Alt-Intro Prompt ───');
  toLLMLog(`[system] ${altIntroPrompt.split('\n').slice(0, 3).join(' ')}`);

  const response = await callOllama(
    [
      { role: 'system', content: altIntroPrompt },
      { role: 'user', content: userPrompt },
    ],
    [],
    { spinnerMessage: 'Clarifying' },
  );

  const answer = extractAssistantText(response.message);
  return answer;
}

async function main() {
  const {
    client,
    toolInventory,
    resourceInventory,
    promptInventory,
    transport,
  } = await connectToMcp();

  // Log resource and prompt counts (if any)
  if (resourceInventory.length > 0 || promptInventory.length > 0) {
    agentLog(`[agent] Resources: ${resourceInventory.length}, Prompts: ${promptInventory.length}`);
  }

  // Generate dynamic prompts from tool catalog
  agentLog('[agent] Generating agent prompts from tool catalog...');
  const agentPrompts = await generateAgentPrompts(toolInventory, client);

  const rl = readline.createInterface({
    input,
    output,
  });

  // Start continuous voice listener
  initVoiceListener();

  let shuttingDown = false;
  const commandHistory = [];

  // Show and speak the agent's role
  stopSpinner();
  blankLine();
  assistantLog(agentPrompts.role_for_user);
  say(agentPrompts.role_for_user);
  blankLine();
  agentLog(
    '[agent] Type or speak a prompt (or "exit" to quit).',
  );

  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    hear(false); // Stop voice listener
    rl.close();
    try {
      await transport.close();
    } catch {
      // ignore
    }
  };

  process.on('SIGINT', async () => {
    agentLog('\n[agent] Caught Ctrl+C. Shutting down...');
    await shutdown();
    process.exit(0);
  });

  while (true) {
    let userInput;
    try {
      voiceBusy = false; // Ready for input
      const { source, text } = await getNextInput(rl);
      voiceBusy = true; // Now processing
      userInput = text;
      if (source === 'voice') {
        // Echo voice input to console
        output.write(`you> ${text}\n`);
      }
    } catch (error) {
      if (error && typeof error === 'object') {
        const code = /** @type {{ code?: string }} */ (error).code;
        if (code === 'ERR_USE_AFTER_CLOSE' || code === 'ABORT_ERR') {
          await shutdown();
          break;
        }
      }
      throw error;
    }

    const trimmedInput = userInput.trim();
    if (!trimmedInput) {
      continue;
    }
    if (['exit', 'quit'].includes(trimmedInput.toLowerCase())) {
      await shutdown();
      break;
    }

    // Preflight: expand request AND check for matching prompt template
    const lastEntry = commandHistory.at(-1);
    // Use full response with middle truncation, fallback to intro greeting for first input
    const previousResponse = lastEntry?.fullResponse
      ? truncateMiddle(lastEntry.fullResponse, 1000)
      : agentPrompts.role_for_user;
    const { expandedRequest, promptGuidance } = await runPreflightCheck(
      trimmedInput,
      previousResponse,
      toolInventory,
      promptInventory,
      client,
      agentPrompts,
    );

    // Get current status for planning context
    const { statusInfo } = await fetchStatusInfo(client, 'Planning ');

    const historySummary = summarizeHistory(commandHistory, HISTORY_MAX_PROMPTS);
    const planningResult = await planToolSequence(
      expandedRequest,
      toolInventory,
      historySummary,
      agentPrompts,
      promptGuidance,
      statusInfo,
    );
    blankLine();

    try {
      let answer = '';
      let toolEvents = [];

      if (planningResult.sequence.length > 0) {
        // Sequential tool execution - planned tools found
        separator('EXECUTION');
        agentLog(
          `Running ${planningResult.sequence.length} tools: ${planningResult.sequence.join(' → ')}`,
        );
        say(`The ${formatToolListForSpeech(planningResult.sequence)} tools will be used.`);
        blankLine();

        const result = await runSequentialToolExecution(
          trimmedInput,
          planningResult.sequence,
          toolInventory,
          client,
          agentPrompts,
        );
        toolEvents = result.toolEvents;

        // Final summary call - include mission context from Intro
        const summaryPrompt = buildSummaryPrompt(trimmedInput, toolEvents);
        const summarySystemPrompt = `${agentPrompts.role_for_assistant}\n\nSummarize what was accomplished based on the tool results.\n\n${summaryPrompt}`;
        const summaryResponse = await callOllama(
          [
            { role: 'system', content: summarySystemPrompt },
          ],
          [],
          { spinnerMessage: 'Finalizing' },
        );
        answer = extractAssistantText(summaryResponse.message);
      } else if (planningResult.needsAltIntro) {
        // No tools determined - run alt_intro process
        answer = await runAltIntroProcess(
          trimmedInput,
          toolInventory,
          commandHistory,
          agentPrompts,
          client,
        );
      } else {
        // Empty sequence but no alt_intro needed (shouldn't happen, but handle gracefully)
        answer = 'I could not determine which tools to use for your request. Please try rephrasing.';
      }

      stopSpinner();
      blankLine();
      separator('ANSWER');
      assistantLog(answer);
      say(answer);
      commandHistory.push({
        prompt: trimmedInput,
        toolEvents,
        finalSummary: truncateMiddle(
          flattenWhitespace(answer),
          HISTORY_RESULT_TEXT_LIMIT,
        ),
        fullResponse: answer,
      });
    } catch (error) {
      stopSpinner();
      agentError(`[agent] Failed to get answer: ${describeError(error)}`);
    }
    blankLine();
  }

  await shutdown();
}

try {
  await main();
} catch (error) {
  agentError('[agent] Fatal error:', error);
  process.exit(1);
}
