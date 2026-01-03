#!/usr/bin/env node
/**
 * Test script for STT phonetic preprocessing.
 * Usage: npm run pho -- "launch to orbit and return to Carbon"
 */

import "dotenv/config";
import path from "node:path";
import { preprocessSttInput } from "./stt/index.js";
import { connectToMcp } from "./mcp/client.js";
import { fetchStatusInfo } from "./mcp/resources.js";
import type { Config } from "./types.js";

function resolvePath(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

async function main() {
  // Get phrase from args (skip node and script name)
  const phrase = process.argv.slice(2).join(" ");
  if (!phrase) {
    console.error('Usage: npm run pho -- "your phrase here"');
    process.exit(1);
  }

  console.log(`Input:  "${phrase}"`);
  console.log("---");

  // Minimal loggers
  const agentLog = (msg: string) => console.log(msg);
  const agentWarn = (msg: string) => console.warn(msg);

  // Build config from env vars
  const config: Config = {
    model: "unused",
    ollamaUrl: "unused",
    transport: (process.env["MCP_TRANSPORT"] ?? "stdio").toLowerCase() as "stdio" | "http",
    mcpBin: resolvePath(process.env["MCP_BIN"] ?? ""),
    mcpHttpUrl: process.env["MCP_HTTP_URL"] ?? "http://127.0.0.1:3000/mcp",
    maxRetries: 3,
    toolTimeout: 30000,
    debug: false,
    speechEnabled: false,
  };

  // Connect to MCP
  console.log("Connecting to MCP...");
  const { client, toolInventory } = await connectToMcp({
    config,
    agentLog,
    agentWarn,
  });

  console.log(`Tools: ${toolInventory.length} loaded`);

  // Get status
  const { statusInfo } = await fetchStatusInfo(client, { agentLog, agentWarn });
  console.log(`Status: ${statusInfo.length} chars`);
  console.log("---");

  // Run preprocessing
  const result = preprocessSttInput(phrase, toolInventory, statusInfo);

  // Show debug log
  for (const line of result.debugLog) {
    console.log(line);
  }

  console.log("---");
  console.log(`Output: "${result.text}"`);

  // Cleanup
  await client.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
