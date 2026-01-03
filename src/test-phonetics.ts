#!/usr/bin/env node
/**
 * Test script for STT phonetic correction via hear-say.
 * Usage: npm run test-phonetics -- "launch to orbit and navigate to Minas"
 */

import "dotenv/config";
import path from "node:path";
import { setDictionary, setPhoneticCorrection, correctText } from "hear-say";
import { connectToMcp } from "./mcp/client.js";
import { fetchStatusInfo } from "./mcp/resources.js";
import { buildDictionary } from "./stt/build-dictionary.js";
import type { Config } from "./types.js";

function resolvePath(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

async function main(): Promise<void> {
  // Get phrase from args (skip node and script name)
  const phrase = process.argv.slice(2).join(" ");
  if (!phrase) {
    console.error('Usage: npm run test-phonetics -- "your phrase here"');
    process.exit(1);
  }

  console.log(`Input:  "${phrase}"`);
  console.log("---");

  // Minimal loggers
  const agentLog = (msg: string): void => console.log(msg);
  const agentWarn = (msg: string): void => console.warn(msg);

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

  // Build dictionary and set in hear-say
  const dictionary = buildDictionary(toolInventory, statusInfo);
  console.log(`Dictionary: ${dictionary.length} terms`);

  // Show sample entries
  console.log("Sample entries:");
  for (const entry of dictionary.slice(0, 10)) {
    console.log(`  "${entry.term}" (weight: ${entry.weight})`);
  }
  console.log("---");

  // Enable debug mode to see matching decisions
  setPhoneticCorrection({ debug: true });
  setDictionary(dictionary);

  // Run correction (as if it were a final STT result)
  const corrected = correctText(phrase, true);

  console.log("---");
  console.log(`Output: "${corrected}"`);

  if (corrected !== phrase) {
    console.log("✓ Corrections applied");
  } else {
    console.log("○ No corrections needed");
  }

  // Cleanup
  await client.close();
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
