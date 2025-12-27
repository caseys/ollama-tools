import path from "node:path";
import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Config, McpResource, McpPrompt } from "../types.js";
import type { Logger } from "../ui/logger.js";
import type { InventoryEntry } from "../utils/tools.js";
import { convertToolsForOllama } from "./conversion.js";

export interface McpClientDeps {
  config: Config;
  agentLog: Logger;
  agentWarn: Logger;
}

export interface McpConnectionResult {
  client: Client;
  toolInventory: InventoryEntry[];
  resourceInventory: McpResource[];
  promptInventory: McpPrompt[];
  transport: StdioClientTransport | StreamableHTTPClientTransport;
}

function buildStdioCommand(mcpBin: string): { command: string; args: string[] } {
  if (!mcpBin) {
    throw new Error("MCP binary path is not configured.");
  }
  const extension = path.extname(mcpBin).toLowerCase();
  const isJs = [".js", ".mjs", ".cjs"].includes(extension);
  if (isJs) {
    return {
      command: process.execPath,
      args: [mcpBin, "--transport", "stdio"],
    };
  }
  return {
    command: mcpBin,
    args: ["--transport", "stdio"],
  };
}

export async function connectToMcp(deps: McpClientDeps): Promise<McpConnectionResult> {
  const { config, agentLog, agentWarn } = deps;

  agentLog(
    `[agent] Connecting to MCP server (${config.transport}) to read tools...`
  );

  let transportInstance: StdioClientTransport | StreamableHTTPClientTransport;
  if (config.transport === "stdio") {
    const { command, args } = buildStdioCommand(config.mcpBin);
    const stdioTransport = new StdioClientTransport({
      command,
      args,
      cwd: path.dirname(config.mcpBin),
      env: process.env as Record<string, string>,
      stderr: "pipe",
    });

    const stderrStream = stdioTransport.stderr;
    if (stderrStream) {
      stderrStream.on("data", (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text.length > 0) {
          console.error(`[ksp-mcp] ${text}`);
        }
      });
    }
    transportInstance = stdioTransport;
  } else {
    const url = new URL(config.mcpHttpUrl);
    transportInstance = new StreamableHTTPClientTransport(url);
  }

  const client = new Client({
    name: "ollama-local-agent",
    version: "0.1.0",
  });

  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
  await client.connect(transportInstance as any);
  const { tools } = await client.listTools({});
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
  const toolInventory = convertToolsForOllama(tools as any);

  let resourceInventory: McpResource[] = [];
  try {
    const { resources } = await client.listResources({});
    resourceInventory = (resources ?? []) as McpResource[];
    agentLog(`[agent] Loaded ${resourceInventory.length} MCP resources.`);
  } catch {
    agentWarn(
      "[agent] Failed to list resources (server may not support them)."
    );
  }

  let promptInventory: McpPrompt[] = [];
  try {
    const { prompts } = await client.listPrompts({});
    promptInventory = (prompts ?? []) as McpPrompt[];
    agentLog(`[agent] Loaded ${promptInventory.length} MCP prompts.`);
  } catch {
    agentWarn("[agent] Failed to list prompts (server may not support them).");
  }

  agentLog(
    `[agent] Loaded ${tools.length} MCP tools and exposed them to Ollama.`
  );

  return {
    client,
    toolInventory,
    resourceInventory,
    promptInventory,
    transport: transportInstance,
  };
}
