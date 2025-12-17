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
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

let stemmerFn;
try {
  const stemmerModule = await import('stemmer');
  stemmerFn =
    stemmerModule?.default ??
    stemmerModule?.stemmer ??
    stemmerModule?.Stemmer ??
    null;
} catch {
  stemmerFn = null;
}
const stemmer =
  typeof stemmerFn === 'function'
    ? stemmerFn
    : (token) => String(token ?? '').toLowerCase();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_SYSTEM_PROMPT = `You are a tool-using assistant.  Think about the user query and tools required.  Do not guess or fabricate tool output.  Do not list all tools.`;
const MAX_SEQUENTIAL_PLAN_LENGTH = 6;
const PLANNING_SYSTEM_PROMPT = `Pick the smallest tool sequence (max ${MAX_SEQUENTIAL_PLAN_LENGTH}) from TOOL LIST. Follow RULES!

RULES:
1. ONLY exact tool names from TOOL LIST - NO invented names
2. List tool names in the EXACT SAME ORDER as the tools available to planner
3. Do NOT add extra tools
4. If one tool solves it, return only that tool

OUTPUT: ["tool_name"] or ["first_tool", "second_tool", ...]`;

const SINGLE_TOOL_SYSTEM_PROMPT = `You are a tool-calling assistant. You MUST call the provided tool for this step. Extract argument values from the user's request. Do not explain - just call the tool with the correct arguments.`;

const TOOL_PRIMER_LIMIT = 12;
const TOOL_DESCRIPTION_MAX = 110;
const MAX_TOOL_REMINDERS = 2;
const PLANNING_CATALOG_LIMIT = 6;
const TOOL_REMINDER_PROMPT =
  'Reminder: when a tool is needed, reply with an assistant message that has empty content and only the tool_calls entry.';
const INCOMPLETE_RESPONSE_PROMPT =
  'Reminder: your previous reply did not answer the request. Continue the task and invoke tools as needed until the request is satisfied.';
const MAX_TOOLS_PER_CALL = 12;
const MIN_TOOLS_PER_CALL = 1;
const HISTORY_MAX_PROMPTS = 5;
const HISTORY_PROMPT_TEXT_LIMIT = 140;
const HISTORY_RESULT_TEXT_LIMIT = 160;
const HISTORY_EVENT_TEXT_LIMIT = 110;
const COLOR_CODES = {
  reset: '\x1b[0m',
  agent: '\x1b[36m',
  tool: '\x1b[33m',
  assistant: '\x1b[32m',
  warn: '\x1b[35m',
  error: '\x1b[31m',
};
const ENABLE_COLOR =
  process.stdout.isTTY &&
  (process.env.NO_COLOR ?? '').toLowerCase() !== '1';

function colorize(message, color) {
  if (!ENABLE_COLOR || !color) {
    return message;
  }
  return `${color}${message}${COLOR_CODES.reset}`;
}

function makeLogger(method, color) {
  return (message, ...rest) => {
    if (rest.length > 0) {
      console[method](colorize(message, color), ...rest);
    } else {
      console[method](colorize(message, color));
    }
  };
}

function blankLine() {
  process.stdout.write('\n');
}

function separator(label = '') {
  const line = '─'.repeat(40);
  if (label) {
    console.log(colorize(`${line} ${label} ${line}`, COLOR_CODES.agent));
  } else {
    console.log(colorize(line, COLOR_CODES.agent));
  }
}

const agentLog = makeLogger('log', COLOR_CODES.agent);
const agentWarn = makeLogger('warn', COLOR_CODES.warn);
const agentError = makeLogger('error', COLOR_CODES.error);
const toolLog = makeLogger('log', COLOR_CODES.tool);
const assistantLog = makeLogger('log', COLOR_CODES.assistant);

const {
  values: {
    model,
    ollamaUrl,
    systemPrompt,
    transport,
    mcpBin,
    mcpHttpUrl,
    maxIterations,
    maxRetries,
    coreTools,
    toolTimeout,
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
    systemPrompt: {
      type: 'string',
      default: process.env.SYSTEM_PROMPT ?? DEFAULT_SYSTEM_PROMPT,
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
    maxIterations: {
      type: 'string',
      default: process.env.MAX_ITERATIONS ?? '20',
    },
    maxRetries: {
      type: 'string',
      default: process.env.MAX_RETRIES ?? '3',
    },
    coreTools: {
      type: 'string',
      default: process.env.CORE_TOOLS ?? '',
    },
    toolTimeout: {
      type: 'string',
      default: process.env.TOOL_TIMEOUT ?? '900000',  // 15 minutes for long-running ops
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
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) || parsed < 1 ? defaultValue : parsed;
}

const config = {
  model,
  ollamaUrl,
  systemPrompt,
  transport: transport.toLowerCase(),
  mcpBin: resolveMcpBin(mcpBin),
  mcpHttpUrl,
  maxIterations: parsePositiveInt(maxIterations, 20),
  maxRetries: parsePositiveInt(maxRetries, 3),
  coreTools,
  toolTimeout: parsePositiveInt(toolTimeout, 600000),
};

if (!['stdio', 'http'].includes(config.transport)) {
  console.error(
    `Unsupported MCP transport "${config.transport}". Use "stdio" or "http".`,
  );
  process.exit(1);
}

// Core tools that are always included in tool selection (configurable via --coreTools)
const ALWAYS_INCLUDE_TOOLS = config.coreTools
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

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
  const openAiTools = toolInventory.map((entry) => entry.openAi);
  const toolPrimerMessage = buildToolPrimer(tools);
  agentLog(
    `[agent] Loaded ${tools.length} MCP tools and exposed them to Ollama.`,
  );

  return {
    client,
    toolInventory,
    transport: transportInstance,
    toolPrimerMessage,
  };
}

function buildStdioCommand() {
  const bin = config.mcpBin;
  if (!bin) {
    throw new Error('MCP binary path is not configured.');
  }
  const ext = path.extname(bin).toLowerCase();
  const isJs = ['.js', '.mjs', '.cjs'].includes(ext);
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
  const initialEntries = tools.map((tool) => {
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
    const parameterNames = parameterKeys.join(' ');
    const descriptionTokens = tokenizeText(
      openAiTool.function.description ?? '',
    );
    const parameterTokens = parameterKeys.flatMap((key) => tokenizeText(key));
    const nameTokens = generateSearchTokens(openAiTool.function.name);
    const combinedTokens = new Set([
      ...nameTokens,
      ...descriptionTokens,
      ...parameterTokens,
    ]);
    const searchTokens = Array.from(combinedTokens);
    const stemTokens = Array.from(
      new Set(searchTokens.map((token) => stemToken(token)).filter(Boolean)),
    );
    const searchText = [
      ...searchTokens,
      openAiTool.function.description ?? '',
      parameterNames,
    ]
      .join(' ')
      .toLowerCase();
    const nameFragments = generateNameFragments(openAiTool.function.name);

    return {
      openAi: openAiTool,
      searchText,
      parameterKeys,
      searchTokens,
      searchTokenSet: new Set(searchTokens),
      stemTokens,
      stemTokenSet: new Set(stemTokens),
      nameFragments,
      recommendedTools: [],
      // MCP metadata
      tier: tool._meta?.tier ?? 2,
      annotations: tool.annotations ?? {},
      isReadOnly: tool.annotations?.readOnlyHint ?? false,
      isDestructive: tool.annotations?.destructiveHint ?? false,
    };
  });

  const descriptions = tools.map((tool) => tool.description ?? '');
  initialEntries.forEach((entry, index) => {
    const description = descriptions[index].toLowerCase();
    const collapsedDesc = description.replace(/[\s_-]/g, '');
    const references = [];
    initialEntries.forEach((candidate, candidateIndex) => {
      if (candidateIndex === index) {
        return;
      }
      if (
        candidate.searchTokens.some((token) => {
          const collapsedToken = token.replace(/[\s_-]/g, '');
          return (
            description.includes(token) ||
            collapsedDesc.includes(collapsedToken)
          );
        })
      ) {
        references.push(candidate.openAi.function.name);
      }
    });
    entry.recommendedTools = references;
  });

  return initialEntries;
}

function generateSearchTokens(name) {
  if (!name) {
    return [];
  }
  const variants = new Set();
  const lower = name.toLowerCase();
  variants.add(lower);
  variants.add(
    name
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_-]+/g, ' ')
      .toLowerCase(),
  );
  variants.add(lower.replace(/[_-]+/g, ' '));
  variants.add(lower.replace(/[\s_-]+/g, ''));
  const tokens = new Set();
  variants.forEach((value) => {
    tokenizeText(value).forEach((token) => tokens.add(token));
  });
  return Array.from(tokens);
}

function generateNameFragments(name) {
  if (!name) {
    return [];
  }
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ');
  return tokenizeText(spaced);
}

// Common stop words to filter out during keyword extraction
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was',
  'one', 'our', 'out', 'has', 'have', 'been', 'were', 'they', 'this', 'that',
  'with', 'from', 'will', 'would', 'there', 'their', 'what', 'about', 'which',
  'when', 'make', 'like', 'just', 'over', 'such', 'into', 'than', 'then', 'them',
  'these', 'some', 'could', 'other', 'very', 'after', 'most', 'also', 'made',
  'please', 'want', 'need', 'help', 'using', 'use', 'run', 'let', 'now', 'how',
  'plan', 'create', 'setup', 'first', 'next', 'before', 'should', 'show', 'tell',
  'current', 'give', 'report', 'check', 'get', 'find', 'look', 'see', 'call',
]);

function tokenizeText(text) {
  if (!text) {
    return [];
  }
  const matches = text.toLowerCase().match(/[a-z0-9]{3,}/g);
  const filtered = (matches ?? []).filter((word) => !STOP_WORDS.has(word));
  return Array.from(new Set(filtered));
}

function stemToken(token) {
  if (!token) {
    return '';
  }
  return stemmer(String(token)).toLowerCase();
}

function buildToolPrimer(tools) {
  if (!tools.length) {
    return '';
  }

  const lines = [];
  const limitedTools = tools.slice(0, TOOL_PRIMER_LIMIT);
  for (const tool of limitedTools) {
    const raw = (tool.description ?? 'No description provided.')
      .replace(/\s+/g, ' ')
      .trim();
    const truncated =
      raw.length > TOOL_DESCRIPTION_MAX
        ? `${raw.slice(0, TOOL_DESCRIPTION_MAX - 3)}...`
        : raw;
    lines.push(`- ${tool.name}: ${truncated}`);
  }

  const remaining = tools.length - limitedTools.length;
  const extraLine =
    remaining > 0 ? `- ...plus ${remaining} more tool(s).` : '';

  return [
    `Tools available (${tools.length}).`,
    'Pick the best match, call it, and wait for the result. Do not invent tool names.',
    ...lines,
    extraLine,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Send the current conversation + tool definitions to Ollama's /api/chat endpoint.
 * Includes exponential backoff retry logic.
 */
async function callOllama(messages, tools, overrides = {}) {
  return callOllamaWithSignal(messages, tools, null, overrides);
}

/**
 * Call Ollama with an optional AbortSignal for timeout support.
 */
async function callOllamaWithSignal(messages, tools, signal, overrides = {}) {
  const maxRetries = Math.max(1, config.maxRetries || 1);
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { options: optionOverrides, ...restOverrides } = overrides;
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

      const response = await fetch(`${config.ollamaUrl}/api/chat`, fetchOptions);

      if (!response.ok) {
        const text = await response.text();
        throw new Error(
          `Ollama call failed with status ${response.status}: ${text}`,
        );
      }
      return response.json();
    } catch (error) {
      // Don't retry on abort
      if (error.name === 'AbortError') {
        throw new Error('Planning step timed out');
      }
      if (attempt === maxRetries) {
        throw error;
      }
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
      agentWarn(
        `[agent] Ollama call failed, retrying in ${delay}ms (${attempt}/${maxRetries})...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

function buildOrderedToolCatalog(prompt, toolInventory) {
  const keywordInfo = buildKeywordInfo(prompt ?? '');
  agentLog(`[agent] Keywords extracted: ${keywordInfo.tokens.join(', ')}`);
  const scored = toolInventory.map((entry) => ({
    name: entry.openAi.function.name,
    description: entry.openAi.function.description ?? 'MCP tool',
    score: scoreToolEntry(entry, keywordInfo),
  }));
  scored.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.name.localeCompare(b.name);
  });
  // Log top 5 scores for debugging
  const topScores = scored.slice(0, 5).map((t) => `${t.name}(${t.score})`).join(', ');
  agentLog(`[agent] Top tool scores: ${topScores}`);
  return scored;
}

function formatToolCatalogForPlanning(catalog) {
  return catalog.map((entry) => entry.name).join(', ');
}

function formatPlanningPrompt(messages) {
  return messages
    .map(
      (message, index) =>
        `--- message ${index + 1} (${message.role}) ---\n${message.content}`,
    )
    .join('\n');
}

function parsePlannedToolsResponse(text, toolInventory) {
  if (!text) {
    return [];
  }

  const availableNames = toolInventory.map(
    (entry) => entry.openAi.function.name,
  );
  const lowerNameMap = new Map(
    availableNames.map((name) => [name.toLowerCase(), name]),
  );

  // Helper: find best matching tool name (exact, then prefix, then stem-based word-boundary)
  function findToolMatch(input) {
    const lower = input.toLowerCase().replace(/[\s-]/g, '_');
    const inputStem = stemToken(lower);

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
    // Stem-based word-boundary match: stems must match
    // e.g., "circularization" stems to "circular", "circularize" stems to "circular"
    for (const [key, value] of lowerNameMap) {
      const fragments = key.split('_');
      const fragmentStems = fragments.map((f) => stemToken(f));
      if (fragmentStems.includes(inputStem)) {
        return value;
      }
    }
    // Fuzzy match: allow single character typo (edit distance of 1)
    for (const [key, value] of lowerNameMap) {
      if (levenshteinDistance(lower, key) === 1) {
        return value;
      }
    }
    return null;
  }

  // Try JSON parsing first
  try {
    const parsed = JSON.parse(text);

    // Handle JSON array: ["set_target", "hohmann_transfer"]
    if (Array.isArray(parsed)) {
      const sequence = [];
      for (const item of parsed) {
        const name = String(item).trim();
        const match = findToolMatch(name);
        if (match && !sequence.includes(match)) {
          sequence.push(match);
        }
      }
      if (sequence.length > 0) {
        return sequence;
      }
    }

    // Handle JSON object with "tools" key: {"tools": ["set_target", ...]}
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.tools)) {
      const sequence = [];
      for (const item of parsed.tools) {
        const name = String(item).trim();
        const match = findToolMatch(name);
        if (match && !sequence.includes(match)) {
          sequence.push(match);
        }
      }
      if (sequence.length > 0) {
        return sequence;
      }
    }

    // Handle JSON object with tool names as keys: {"set_target": [], "hohmann_transfer": []}
    // Only use if there are 1-10 keys (not the full catalog)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const keys = Object.keys(parsed);
      if (keys.length >= 1 && keys.length <= 10) {
        const sequence = [];
        for (const key of keys) {
          const match = findToolMatch(key);
          if (match && !sequence.includes(match)) {
            sequence.push(match);
          }
        }
        if (sequence.length > 0) {
          return sequence;
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
        const sequence = [];
        for (const item of parsed) {
          const name = String(item).trim();
          const match = findToolMatch(name);
          if (match && !sequence.includes(match)) {
            sequence.push(match);
          }
        }
        if (sequence.length > 0) {
          return sequence;
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
        .replace(/^[\d\.\-\s\[\]"']+/, '')
        .replace(/[\[\]"']+$/, '')
        .trim(),
    )
    .filter(Boolean);

  const sequence = [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower === 'none' || lower === '[]') {
      return [];
    }

    // Use fuzzy matching
    const match = findToolMatch(token);
    if (match && !sequence.includes(match)) {
      sequence.push(match);
    }
  }

  return sequence;
}

async function planToolSequence(userPrompt, toolInventory, historySummary = '') {
  agentLog('[agent] Planning tool sequence...');
  if (!userPrompt || !userPrompt.trim()) {
    return { sequence: [], rawText: '' };
  }
  const catalog = buildOrderedToolCatalog(userPrompt, toolInventory);
  // Select top N most relevant tools, keep score order (highest first)
  const limitedCatalog = catalog.slice(0, PLANNING_CATALOG_LIMIT);
  const toolNames = limitedCatalog.map((t) => t.name).join(', ');
  agentLog(`[agent] Tools shown to planner: ${toolNames}`);
  const catalogText = formatToolCatalogForPlanning(limitedCatalog);
  const historySection = historySummary ? `History:\n${historySummary}\n\n` : '';
  const planningMessages = [
    {
      role: 'system',
      content: PLANNING_SYSTEM_PROMPT,
    },
    {
      role: 'user',
      content: `${historySection}Request: ${userPrompt}\n\nTOOL LIST: ${catalogText}`,
    },
  ];
  agentLog(
    '[agent] Planning prompt:\n' + formatPlanningPrompt(planningMessages),
  );
  try {
    agentLog('[agent] Calling Ollama for planning...');
    // Add timeout for planning step (30 seconds)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    // Use JSON schema for structured output - simple array of tool names
    const response = await callOllamaWithSignal(
      planningMessages,
      [],
      controller.signal,
      {
        format: {
          type: 'array',
          items: { type: 'string' },
        },
        options: {
          temperature: 0,
          top_p: 0.5,
        },
      },
    );
    clearTimeout(timeoutId);

    const planningMessage = response.message;
    const planText = extractAssistantText(planningMessage).trim();

    // Log raw planning response for debugging
    agentLog(`[agent] Planning LLM returned: ${planText.slice(0, 200)}${planText.length > 200 ? '...' : ''}`);

    const sequence = parsePlannedToolsResponse(planText, toolInventory);
    const filteredSequence = filterPlanSequenceByRelevance(
      sequence,
      userPrompt,
      toolInventory,
    );
    const catalogSize = limitedCatalog.length;
    if (
      catalogSize >= 3 &&
      filteredSequence.length >= Math.max(3, catalogSize - 1)
    ) {
      agentWarn(
        `[agent] Planning step selected ${filteredSequence.length}/${catalogSize} catalog tools. Treating plan as invalid.`,
      );
      return { sequence: [], rawText: planText };
    }

    // Sanity check: if we got way more tools than expected, discard
    const MAX_REASONABLE_PLAN_LENGTH = 15;
    if (filteredSequence.length > MAX_REASONABLE_PLAN_LENGTH) {
      agentWarn(
        `[agent] Planning returned ${filteredSequence.length} tools (likely parsing error). Ignoring plan.`,
      );
      return { sequence: [], rawText: planText };
    }

    if (filteredSequence.length > MAX_SEQUENTIAL_PLAN_LENGTH) {
      agentWarn(
        `[agent] Planning returned ${filteredSequence.length} tools (exceeds sequential limit of ${MAX_SEQUENTIAL_PLAN_LENGTH}). Falling back to open-ended loop.`,
      );
      return { sequence: [], rawText: planText };
    }

    if (filteredSequence.length > 0) {
      agentLog(
        `[agent] Planned tool order: ${filteredSequence.join(' -> ')}`,
      );
    } else {
      agentLog('[agent] Planning step returned no tools (no matches found in response).');
    }
    return { sequence: filteredSequence, rawText: planText };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    agentWarn(`[agent] Planning step failed: ${message}`);
    return { sequence: [], rawText: '' };
  }
}

function filterPlanSequenceByRelevance(sequence, userPrompt, toolInventory) {
  if (!Array.isArray(sequence) || sequence.length === 0) {
    return [];
  }
  const seen = new Set();
  const normalized = [];
  for (const name of sequence) {
    if (seen.has(name)) {
      continue;
    }
    const entry = findToolEntry(toolInventory, name);
    if (!entry) {
      continue;
    }
    seen.add(name);
    normalized.push(name);
  }
  return normalized;
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
      if (entry.type === 'text') {
        segments.push(sanitizeToolText(entry.text));
      } else if (entry.type === 'json') {
        segments.push(JSON.stringify(entry.data, null, 2));
      } else if (entry.type === 'resource') {
        segments.push(
          `resource(${entry.resource?.uri ?? 'unknown'}): ${entry.resource?.text ?? ''
          }`,
        );
      } else {
        segments.push(`[${entry.type}] ${JSON.stringify(entry)}`);
      }
    }
  }

  if (segments.length === 0) {
    segments.push('(no content)');
  }

  const combined = sanitizeToolText(segments.join('\n'));
  return removeScriptNoise(combined, result.isError);
}

function safeParseArgs(rawArgs) {
  if (!rawArgs || Object.keys(rawArgs).length === 0) {
    return {};
  }

  if (typeof rawArgs === 'string') {
    try {
      return rawArgs.length ? JSON.parse(rawArgs) : {};
    } catch (error) {
      throw new Error(`Tool arguments are not valid JSON: ${rawArgs}`);
    }
  }

  return rawArgs;
}

function selectRelevantTools(conversation, toolInventory) {
  const latestUserText = getLatestUserText(conversation) ?? '';
  const keywordInfo = buildKeywordInfo(latestUserText);

  const scored = toolInventory
    .map((entry) => ({
      entry,
      score: scoreToolEntry(entry, keywordInfo),
    }))
    .sort((a, b) => b.score - a.score);

  const selected = [];
  for (const item of scored) {
    if (selected.length >= MAX_TOOLS_PER_CALL) {
      break;
    }
    selected.push(item.entry.openAi);
  }

  for (const always of ALWAYS_INCLUDE_TOOLS) {
    if (
      selected.find((tool) => tool.function.name === always) ||
      !toolInventory.find((entry) => entry.openAi.function.name === always)
    ) {
      continue;
    }
    const entry = toolInventory.find(
      (candidate) => candidate.openAi.function.name === always,
    );
    if (entry) {
      selected.push(entry.openAi);
    }
  }

  if (selected.length < MIN_TOOLS_PER_CALL) {
    for (const entry of toolInventory) {
      if (selected.length >= MIN_TOOLS_PER_CALL) {
        break;
      }
      if (
        selected.find(
          (tool) => tool.function.name === entry.openAi.function.name,
        )
      ) {
        continue;
      }
      selected.push(entry.openAi);
    }
  }

  const result =
    selected.length > 0
      ? selected.slice(0, MAX_TOOLS_PER_CALL)
      : toolInventory
          .slice(0, MAX_TOOLS_PER_CALL)
          .map((entry) => entry.openAi);

  const names = result.map((tool) => tool.function.name).join(', ');
  agentLog(`[agent] Tools for this turn: ${names}`);
  return result;
}

function findToolEntry(toolInventory, toolName) {
  return toolInventory.find(
    (entry) => entry.openAi.function.name === toolName,
  );
}

function normalizeArgumentsForEntry(entry, rawArgs) {
  if (!rawArgs || typeof rawArgs !== 'object') {
    return {};
  }

  const allowedKeys = entry?.parameterKeys ?? [];
  const normalized = {};
  for (const [key, value] of Object.entries(rawArgs)) {
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

function scoreToolEntry(entry, keywordInfo) {
  const tokens = keywordInfo.tokens;
  const stems = keywordInfo.stems;
  if (tokens.length === 0) {
    return 0;
  }
  let score = 0;
  tokens.forEach((token, index) => {
    const escapedToken = escapeRegExp(token);

    // Exact token match in searchTokenSet - highest priority
    if (entry.searchTokenSet?.has(token)) {
      score += Math.min(token.length, 8) + 4; // boost exact matches
    } else {
      // Word boundary match at start of word (e.g., "target" matches "set_target")
      const wordBoundaryStart = new RegExp(`\\b${escapedToken}`, 'i');
      if (wordBoundaryStart.test(entry.searchText)) {
        score += 3;
      }
      // Contained anywhere (weak match, potential false positive)
      else if (entry.searchText.includes(token)) {
        score += 1;
      }
    }

    // Name fragment matching with boundary awareness
    if (entry.nameFragments?.length) {
      for (const fragment of entry.nameFragments) {
        if (fragment === token) {
          score += 6; // exact fragment match
          break;
        }
        // Token starts with fragment or fragment starts with token (prefix match)
        if (fragment.startsWith(token) || token.startsWith(fragment)) {
          score += 4;
          break;
        }
        // Contains match - only if at word boundary
        const fragBoundary = new RegExp(`\\b${escapeRegExp(token)}`, 'i');
        if (fragBoundary.test(fragment)) {
          score += 2;
          break;
        }
      }
    }

    // Stem match
    const stem = stems[index];
    if (stem && entry.stemTokenSet?.has(stem)) {
      score += 4;
    }
  });

  // Tier-based adjustments
  const tier = entry.tier;
  if (tier === 1) {
    score += 10;        // Primary tools get bonus
  } else if (tier === 2) {
    score += 5;         // Supporting tools get small bonus
  } else if (tier === 3) {
    score *= 0.5;       // Specialized tools penalized
  } else if (tier === -1) {
    score = 0;          // Escape hatch tools excluded from auto-selection
  }

  return score;
}

function getLatestUserText(conversation) {
  for (let i = conversation.length - 1; i >= 0; i -= 1) {
    const message = conversation[i];
    if (message.role === 'user' && typeof message.content === 'string') {
      const marker = 'Current request:';
      const content = message.content;
      const markerIndex = content.lastIndexOf(marker);
      if (markerIndex !== -1) {
        return content.slice(markerIndex + marker.length).trim();
      }
      return content;
    }
  }
  return null;
}

function buildKeywordInfo(text) {
  const tokens = tokenizeText(text);
  const stems = tokens.map((token) => stemToken(token));
  return { tokens, stems };
}

function buildPromptWithHistory(userPrompt, history) {
  const summary = summarizeHistory(history, HISTORY_MAX_PROMPTS);
  if (!summary) {
    return userPrompt;
  }
  return `${summary}\n\nCurrent request:\n${userPrompt}`;
}

function buildFocusedToolPrompt(
  userQuery,
  toolEntry,
  previousResult,
  nextTool,
  step,
  total,
) {
  const tool = toolEntry.openAi.function;
  const params = tool.parameters?.properties ?? {};
  const required = tool.parameters?.required ?? [];

  // Build a simple parameter hint
  const paramHints = Object.entries(params).map(([key, schema]) => {
    const req = required.includes(key) ? ' (required)' : '';
    const type = schema.type || 'string';
    const desc = schema.description ? ` - ${schema.description}` : '';
    return `  - ${key}: ${type}${req}${desc}`;
  }).join('\n');

  const lines = [
    `Step ${step}/${total}: Call "${tool.name}"`,
    `Description: ${tool.description}`,
  ];

  if (paramHints) {
    lines.push(
      '',
      'Parameters:',
      paramHints,
      '',
      'Extract values from the user request and call this tool NOW.',
      `"${userQuery}"`,
    );
  }

  if (previousResult) {
    lines.push(
      '',
      `Previous tool used: ${previousResult.tool} - ${previousResult.result}`,
    );
  }

  if (nextTool) {
    lines.push('', `Next tool used: ${nextTool}`);
  }

  return lines.join('\n');
}

function buildSummaryPrompt(userQuery, toolEvents) {
  const lines = [
    `User request: ${userQuery}`,
    '',
    'Tools executed:',
  ];

  toolEvents.forEach((event, idx) => {
    const status = event.success ? '✓' : '✗';
    lines.push(`${idx + 1}. ${event.name} ${status}: ${event.summary}`);
  });

  lines.push('', 'Provide a brief summary of what was accomplished.');

  return lines.join('\n');
}

function summarizeHistory(history, limit) {
  if (!history.length) {
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
  toShow.forEach((entry, idx) => {
    const absoluteIndex = history.length - toShow.length + idx + 1;
    lines.push(
      `${absoluteIndex}. ${truncateText(
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
    const finalSummary = truncateText(
      entry.finalSummary,
      HISTORY_RESULT_TEXT_LIMIT,
    );
    if (finalSummary && finalSummary.length > 0) {
      lines.push(`   result: ${finalSummary}`);
    }
  });
  return lines.join('\n');
}

function truncateText(text, limit) {
  if (!text) {
    return '';
  }
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(0, limit - 3))}...`;
}

function flattenWhitespace(text) {
  return text ? text.replace(/\s+/g, ' ').trim() : '';
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function levenshteinDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix = [];
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

function detectPromisedToolUsage(text, toolInventory) {
  if (!text) {
    return [];
  }
  const verbs = ['call', 'run', 'use', 'invoke', 'execute', 'trigger'];
  const matches = new Set();
  const normalized = text.toLowerCase();
  const textWindow = text.replace(/\s+/g, ' ');
  for (const entry of toolInventory) {
    const toolName = entry.openAi.function.name;
    const escapedName = escapeRegExp(toolName);
    const pattern = new RegExp(
      `\\b(${verbs.join('|')})\\b[^\\.\\n]{0,80}\\b${escapedName}\\b`,
      'i',
    );
    if (pattern.test(textWindow)) {
      matches.add(toolName);
    }
  }
  const genericPattern = new RegExp(
    `\\b(${verbs.join('|')})\\b[^\\.\\n]{0,60}\\btool\\b`,
    'i',
  );
  if (genericPattern.test(normalized)) {
    matches.add('tool');
  }
  return Array.from(matches);
}

function isIncompleteAssistantResponse(message) {
  const text = extractAssistantText(message).trim();
  if (!text) {
    return true;
  }
  const normalized = text.toLowerCase();
  if (normalized === '{}' || normalized === '[]' || normalized === 'null' || normalized === 'undefined') {
    return true;
  }
  if (text.includes('<|python_tag|>')) {
    return true;
  }
  if (/^{"name":\s*".*"}\s*$/s.test(text)) {
    return true;
  }
  return false;
}

function sanitizeToolText(text) {
  if (!text) {
    return '(no output)';
  }
  const cleaned = text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned.length ? cleaned : '(no output)';
}

function describeFailureReason(text, structuredContent) {
  if (structuredContent?.reason) {
    return structuredContent.reason;
  }
  const status = normalizeStructuredStatus(structuredContent?.status);
  if (status === 'error' && structuredContent?.action) {
    return `${structuredContent.action} failed`;
  }
  if (!text) {
    return 'failed';
  }
  const normalized = text.toLowerCase();
  if (normalized.includes('timeout')) {
    return 'timed out';
  }
  if (normalized.includes('not connected')) {
    return 'needs an active connection';
  }
  if (normalized.includes('no target')) {
    return 'needs a target set first';
  }
  if (normalized.includes('not found')) {
    return 'reported missing data';
  }
  return 'failed';
}

function buildIncompleteReminder(rawRequest, summaries) {
  const trimmedRequest = rawRequest ? rawRequest.trim() : '';
  const lines = [];
  lines.push('Reminder: the user request still needs a final answer.');
  if (trimmedRequest) {
    lines.push('');
    lines.push('Request:');
    lines.push(trimmedRequest);
  }
  if (summaries && summaries.length) {
    lines.push('');
    lines.push('Progress so far:');
    summaries.slice(-5).forEach((entry, idx) => {
      lines.push(`${idx + 1}. ${entry}`);
    });
  }
  lines.push('');
  lines.push(
    'Continue the task, calling any required tools, and reply with a final answer when complete.',
  );
  return lines.join('\n');
}

function sanitizeCpuId(value) {
  if (value === null || value === undefined) {
    return undefined;
  }
  const numeric =
    typeof value === 'number' ? value : Number(String(value).trim());
  if (Number.isNaN(numeric)) {
    return undefined;
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
  return cleaned.length ? cleaned : text;
}

function extractToolNamesFromText(text, toolInventory) {
  if (!text) {
    return [];
  }
  const normalized = text.toLowerCase();
  const collapsed = normalized.replace(/[\s_-]/g, '');
  const matches = new Set();
  for (const entry of toolInventory) {
    const name = entry.openAi.function.name;
    for (const token of entry.searchTokens ?? []) {
      if (normalized.includes(token) || collapsed.includes(token.replace(/[\s_-]/g, ''))) {
        matches.add(name);
        break;
      }
    }
  }
  return Array.from(matches);
}

function addFollowupReminderIfNeeded(
  text,
  toolInventory,
  conversation,
  { force = false, preferredTool, failureReason } = {},
) {
  if (!force) {
    return;
  }
  const referencedTools =
    preferredTool && preferredTool.length
      ? [preferredTool]
      : extractToolNamesFromText(text, toolInventory);
  if (!referencedTools.length) {
    return;
  }
  const listed = referencedTools.slice(0, 4).join(', ');
  const reason =
    failureReason && preferredTool
      ? `${preferredTool} ${failureReason}`
      : `the previous result referenced ${listed}`;
  const instruction = preferredTool
    ? `Retry ${preferredTool} (adjust parameters if needed) before calling other tools or answering.`
    : 'Call the needed tool(s) and retry before answering.';
  conversation.push({
    role: 'user',
    content: `Reminder: ${reason}. ${instruction}`,
  });
}

function addRecommendationReminder(entry, conversation) {
  if (!entry?.recommendedTools?.length) {
    return;
  }
  const listed = entry.recommendedTools.slice(0, 4).join(', ');
  conversation.push({
    role: 'user',
    content: `Reminder: run ${listed} as required before retrying.`,
  });
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
) {
  const toolEvents = [];
  let previousResult = null;

  for (let i = 0; i < toolSequence.length; i++) {
    const toolName = toolSequence[i];
    const toolEntry = findToolEntry(toolInventory, toolName);
    if (!toolEntry) {
      agentWarn(`[agent] Tool "${toolName}" not found in inventory, skipping.`);
      continue;
    }

    const nextTool = i < toolSequence.length - 1 ? toolSequence[i + 1] : null;

    // Build focused single-tool prompt
    const focusedPrompt = buildFocusedToolPrompt(
      userPrompt,
      toolEntry,
      previousResult,
      nextTool,
      i + 1,
      toolSequence.length,
    );

    agentLog(
      `[agent] Step ${i + 1}/${toolSequence.length}: Calling ${toolName}...`,
    );

    // Call Ollama with ONLY this one tool - retry once if model doesn't call it
    let args = {};
    let attempts = 0;
    const maxAttempts = 2;

    while (attempts < maxAttempts) {
      attempts++;
      const promptToUse = attempts === 1
        ? focusedPrompt
        : `You MUST call the "${toolName}" tool NOW. This is required.\n\n${focusedPrompt}`;

      const response = await callOllama(
        [
          { role: 'system', content: SINGLE_TOOL_SYSTEM_PROMPT },
          { role: 'user', content: promptToUse },
        ],
        [toolEntry.openAi],
        { format: 'json' },
      );

      const toolCalls = response.message?.tool_calls ?? [];

      if (toolCalls.length > 0) {
        const call = toolCalls[0];
        args = normalizeArgumentsForEntry(
          toolEntry,
          safeParseArgs(call.function?.arguments),
        );
        break;
      }

      if (attempts < maxAttempts) {
        agentWarn(`[agent] Model didn't call ${toolName}. Retrying with stronger prompt...`);
      } else {
        agentWarn(`[agent] Model didn't call ${toolName} after ${maxAttempts} attempts. Using empty args.`);
      }
    }

    toolLog(`▶ ${toolName}`, Object.keys(args).length ? args : '');

    try {
      const result = await client.callTool(
        { name: toolName, arguments: args },
        undefined,
        {
          timeout: config.toolTimeout,
          resetTimeoutOnProgress: true,
        }
      );
      const textResult = formatMcpResult(result);
      toolLog(`  ↳ ${textResult.split('\n')[0]}`);
      if (textResult.includes('\n')) {
        textResult.split('\n').slice(1).forEach(line => {
          if (line.trim()) toolLog(`    ${line}`);
        });
      }

      const success = didToolSucceed(result);
      toolEvents.push({
        name: toolName,
        success,
        summary: truncateText(textResult, HISTORY_EVENT_TEXT_LIMIT),
      });

      previousResult = { tool: toolName, result: textResult };

      if (!success) {
        agentWarn(`[agent] Tool ${toolName} failed. Stopping sequence.`);
        break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      agentError(`[agent] Tool ${toolName} threw error: ${message}`);
      toolEvents.push({
        name: toolName,
        success: false,
        summary: truncateText(message, HISTORY_EVENT_TEXT_LIMIT),
      });
      break;
    }
  }

  return { toolEvents };
}

/**
 * Core agent loop:
 *  - Ask Ollama for the next assistant turn.
 *  - If the model emitted tool_calls, run the MCP tool and feed the result back.
 *  - Repeat until a natural-language reply is produced.
 */
async function runAgentLoop(
  conversation,
  toolInventory,
  client,
  requestContext = {},
) {
  let reminderCount = 0;
  let toolCallCount = 0;
  let iterations = 0;
  const toolEvents = [];
  const progressSummaries = [];

  while (iterations < config.maxIterations) {
    iterations += 1;
    const toolsForThisTurn = selectRelevantTools(conversation, toolInventory);
    agentLog(
      `[agent] Asking Ollama (${config.model}) with ${conversation.length} messages and ${toolsForThisTurn.length} tool(s)...`,
    );

    const response = await callOllama(conversation, toolsForThisTurn);
    const assistantMessage = response.message;
    if (!assistantMessage) {
      throw new Error('Ollama response missing assistant message');
    }
    conversation.push(assistantMessage);

    const toolCalls = assistantMessage.tool_calls ?? [];
    if (toolCalls.length === 0) {
      if (toolCallCount === 0 && reminderCount < MAX_TOOL_REMINDERS) {
        reminderCount += 1;
        agentLog(
          '[agent] Assistant replied without using a tool. Sending reminder...',
        );
        conversation.push({
          role: 'user',
          content: TOOL_REMINDER_PROMPT,
        });
        continue;
      }
      if (
        isIncompleteAssistantResponse(assistantMessage) &&
        reminderCount < MAX_TOOL_REMINDERS
      ) {
        reminderCount += 1;
        agentLog(
          '[agent] Assistant response was incomplete. Asking it to continue...',
        );
        const reminderContent = buildIncompleteReminder(
          requestContext.rawRequest ?? getLatestUserText(conversation),
          progressSummaries,
        );
        conversation.push({
          role: 'user',
          content: reminderContent || INCOMPLETE_RESPONSE_PROMPT,
        });
        continue;
      }
      const content = extractAssistantText(assistantMessage);
      const promisedTools = detectPromisedToolUsage(content, toolInventory);
      if (promisedTools.length && reminderCount < MAX_TOOL_REMINDERS) {
        reminderCount += 1;
        const listed =
          promisedTools[0] === 'tool'
            ? 'the referenced tool'
            : promisedTools.join(', ');
        agentLog(
          '[agent] Assistant promised a tool call but none was made. Requesting follow-up...',
        );
        conversation.push({
          role: 'user',
          content: `Reminder: you said you would call ${listed}, but no tool call was sent. Call the tool now and wait for its output before responding.`,
        });
        continue;
      }
      agentLog('[agent] Model returned final response.');
      return { content, toolEvents };
    }

    for (const call of toolCalls) {
      const name = call.function?.name;
      if (!name) {
        agentWarn('[agent] Received tool call without name. Skipping.');
        continue;
      }

      const rawArgs = safeParseArgs(call.function?.arguments);
      const toolEntry = findToolEntry(toolInventory, name);
      const args = normalizeArgumentsForEntry(toolEntry, rawArgs);
      toolLog(`▶ ${name}`, Object.keys(args).length ? args : '');
      try {
        const result = await client.callTool(
          { name, arguments: args },
          undefined,
          {
            timeout: config.toolTimeout,
            resetTimeoutOnProgress: true,
          }
        );
        toolCallCount += 1;
        const textResult = formatMcpResult(result);
        toolLog(`  ↳ ${textResult.split('\n')[0]}`);
        if (textResult.includes('\n')) {
          textResult.split('\n').slice(1).forEach(line => {
            if (line.trim()) toolLog(`    ${line}`);
          });
        }
        const structuredSummaryLine = buildStructuredSummaryLine(
          result.structuredContent,
        );
        const summarySource =
          structuredSummaryLine ||
          flattenWhitespace(textResult) ||
          '(no output)';
        const summaryText = truncateText(
          summarySource,
          HISTORY_EVENT_TEXT_LIMIT,
        );
        const toolSuccess = didToolSucceed(result);
        toolEvents.push({
          name,
          success: toolSuccess,
          summary: summaryText,
        });
        if (toolSuccess && summaryText) {
          const progressEntry = structuredSummaryLine
            ? truncateText(structuredSummaryLine, HISTORY_EVENT_TEXT_LIMIT)
            : summaryText;
          progressSummaries.push(progressEntry);
        }
        conversation.push({
          role: 'tool',
          tool_name: name,
          content: textResult,
        });
        if (!toolSuccess) {
          const failureReason = describeFailureReason(
            textResult,
            result.structuredContent,
          );
          addFollowupReminderIfNeeded(
            textResult,
            toolInventory,
            conversation,
            {
              force: true,
              preferredTool: name,
              failureReason,
            },
          );
          addRecommendationReminder(toolEntry, conversation);
          return { content: textResult, toolEvents };
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        const errorBlock = sanitizeToolText(`Tool ${name} failed: ${message}`);
        agentError(`[agent] Tool execution failed: ${message}`);
        toolEvents.push({
          name,
          success: false,
          summary: truncateText(message, HISTORY_EVENT_TEXT_LIMIT),
        });
        conversation.push({
          role: 'tool',
          tool_name: name,
          content: errorBlock,
        });
        addFollowupReminderIfNeeded(errorBlock, toolInventory, conversation, {
          force: true,
          preferredTool: name,
          failureReason: describeFailureReason(message),
        });
        addRecommendationReminder(toolEntry, conversation);
        return { content: errorBlock, toolEvents };
      }
    }
  }

  // Max iterations reached - return last assistant message content or empty
  agentWarn(
    `[agent] Max iterations (${config.maxIterations}) reached. Returning last response.`,
  );
  const lastAssistant = conversation
    .slice()
    .reverse()
    .find((m) => m.role === 'assistant');
  return { content: lastAssistant?.content ?? '', toolEvents };
}

async function main() {
  const {
    client,
    toolInventory,
    transport,
    toolPrimerMessage,
  } = await connectToMcp();

  const rl = readline.createInterface({
    input,
    output,
  });

  let shuttingDown = false;
  const commandHistory = [];

  const conversation = [
    {
      role: 'system',
      content: toolPrimerMessage
        ? `${config.systemPrompt}\n\n${toolPrimerMessage}`
        : config.systemPrompt,
    },
  ];

  agentLog(
    '[agent] Ready. Type a prompt (or "exit" to quit). Example: "Check the current kOS status."',
  );

  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
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
      userInput = await rl.question('you> ');
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

    const historySummary = summarizeHistory(commandHistory, HISTORY_MAX_PROMPTS);
    const planningResult = await planToolSequence(
      trimmedInput,
      toolInventory,
      historySummary,
    );
    blankLine();

    try {
      let answer = '';
      let toolEvents = [];
      let shouldResetConversation = false;

      if (planningResult.sequence.length > 0) {
        // Sequential tool execution - no history needed
        separator('EXECUTION');
        agentLog(
          `Running ${planningResult.sequence.length} tools: ${planningResult.sequence.join(' → ')}`,
        );
        blankLine();

        const result = await runSequentialToolExecution(
          trimmedInput,
          planningResult.sequence,
          toolInventory,
          client,
        );
        toolEvents = result.toolEvents;

        // Final summary call
        const summaryPrompt = buildSummaryPrompt(trimmedInput, toolEvents);
        const summaryResponse = await callOllama(
          [
            { role: 'system', content: 'Summarize what was accomplished based on the tool results.' },
            { role: 'user', content: summaryPrompt },
          ],
          [],
        );
        answer = extractAssistantText(summaryResponse.message);
      } else {
        // No tools found - open-ended query with history
        agentLog('[agent] No tools planned. Running open-ended query...');
        const promptWithHistory = buildPromptWithHistory(trimmedInput, commandHistory);
        conversation.push({
          role: 'user',
          content: promptWithHistory,
        });

        const result = await runAgentLoop(
          conversation,
          toolInventory,
          client,
          { rawRequest: trimmedInput },
        );
        answer = result.content;
        toolEvents = result.toolEvents;
        shouldResetConversation = true;
      }

      blankLine();
      separator('ANSWER');
      assistantLog(answer);
      commandHistory.push({
        prompt: trimmedInput,
        toolEvents,
        finalSummary: truncateText(
          flattenWhitespace(answer),
          HISTORY_RESULT_TEXT_LIMIT,
        ),
      });
      if (shouldResetConversation) {
        conversation.splice(1);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      agentError(`[agent] Failed to get answer: ${message}`);
    }
    blankLine();
  }

  await shutdown();
}

main().catch((error) => {
  agentError('[agent] Fatal error:', error);
  process.exit(1);
});
