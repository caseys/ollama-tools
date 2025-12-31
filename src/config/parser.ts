import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import type { ParseResult } from "../types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Platform detection for speech defaults
const isMac = process.platform === "darwin";

function resolveMcpBin(binPath: string | undefined): string {
  if (!binPath) {
    return "";
  }
  return path.isAbsolute(binPath)
    ? binPath
    : path.resolve(process.cwd(), binPath);
}

function parsePositiveInt(value: string, defaultValue: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) || parsed < 1 ? defaultValue : parsed;
}

export function parseConfig(): ParseResult {
  // Determine speech default: enabled on Mac, disabled elsewhere
  // Can be overridden via SPEECH_ENABLED env var
  const speechEnvSet = process.env["SPEECH_ENABLED"] !== undefined;
  const speechDefault = speechEnvSet
    ? process.env["SPEECH_ENABLED"] === "true"
    : isMac;

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
      prompt,
      speech,
    },
  } = parseArgs({
    options: {
      model: {
        type: "string",
        default: process.env["OLLAMA_MODEL"] ?? "llama3.2:3b-instruct-q4_K_M",
      },
      ollamaUrl: {
        type: "string",
        default: process.env["OLLAMA_URL"] ?? "http://localhost:11434",
      },
      transport: {
        type: "string",
        default: process.env["MCP_TRANSPORT"] ?? "stdio",
      },
      mcpBin: {
        type: "string",
        default:
          process.env["MCP_BIN"] ??
          path.resolve(__dirname, "../../../ksp-mcp/dist/index.js"),
      },
      mcpHttpUrl: {
        type: "string",
        default: process.env["MCP_HTTP_URL"] ?? "http://127.0.0.1:3000/mcp",
      },
      maxRetries: {
        type: "string",
        default: process.env["MAX_RETRIES"] ?? "3",
      },
      toolTimeout: {
        type: "string",
        default: process.env["TOOL_TIMEOUT"] ?? "900000",
      },
      debug: {
        type: "boolean",
        default:
          process.env["DEBUG"] === "1" || process.env["DEBUG"] === "true",
      },
      prompt: {
        type: "string",
        short: "p",
      },
      speech: {
        type: "boolean",
        default: speechDefault,
      },
    },
    allowPositionals: false,
  });

  // Check if speech was explicitly enabled on non-Mac platform
  const speechEnabled = speech ?? speechDefault;
  const speechExplicitlyEnabled =
    speechEnvSet || process.argv.includes("--speech");

  if (speechEnabled && !isMac && speechExplicitlyEnabled) {
    console.warn(
      "\n\u26A0\uFE0F  Speech enabled but hear-say only supports macOS currently.\n" +
        "   Please help add support for your platform:\n" +
        "   https://github.com/anthropics/hear-say\n"
    );
  }

  const transportValue = (transport ?? "stdio").toLowerCase();
  if (transportValue !== "stdio" && transportValue !== "http") {
    console.error(
      `Unsupported MCP transport "${transportValue}". Use "stdio" or "http".`
    );
    process.exit(1);
  }

  return {
    config: {
      model: model ?? "llama3.2:3b-instruct-q4_K_M",
      ollamaUrl: ollamaUrl ?? "http://localhost:11434",
      transport: transportValue,
      mcpBin: resolveMcpBin(mcpBin),
      mcpHttpUrl: mcpHttpUrl ?? "http://127.0.0.1:3000/mcp",
      maxRetries: parsePositiveInt(maxRetries ?? "3", 3),
      toolTimeout: parsePositiveInt(toolTimeout ?? "900000", 600_000),
      debug: debug ?? false,
      speechEnabled,
    },
    prompt,
  };
}
