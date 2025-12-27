import type { OllamaTool, ToolInputSchema } from "../types.js";
import { levenshteinDistance, sanitizeToolText, removeScriptNoise, sanitizeCpuId, sanitizeCpuLabel } from "./strings.js";

export interface InventoryEntry {
  openAi: OllamaTool;
  tier?: number;
  parameterKeys: string[];
}

export function getCommonTools(toolInventory: InventoryEntry[]): InventoryEntry[] {
  return toolInventory.filter((t) => (t.tier ?? 2) <= 2);
}

export function getOtherTools(toolInventory: InventoryEntry[]): InventoryEntry[] {
  return toolInventory.filter((t) => (t.tier ?? 2) > 2);
}

export function getCommonToolNames(toolInventory: InventoryEntry[]): string {
  return getCommonTools(toolInventory)
    .map((t) => t.openAi.function.name)
    .join(", ");
}

export function formatToolsByTier(toolInventory: InventoryEntry[]): string {
  const tier1and2 = getCommonTools(toolInventory);
  const otherTools = getOtherTools(toolInventory);

  const lines: string[] = [];

  if (tier1and2.length > 0) {
    for (const t of tier1and2) {
      lines.push(
        `- ${t.openAi.function.name}: ${t.openAi.function.description || "No description"}`
      );
    }
  }

  if (otherTools.length > 0) {
    const otherNames = otherTools.map((t) => t.openAi.function.name).join(", ");
    lines.push(`- Other tools: ${otherNames}`);
  }

  return lines.join("\n");
}

function normalizeStructuredStatus(status: unknown): string {
  if (status === null || status === undefined) {
    return "";
  }
  if (typeof status !== "string" && typeof status !== "number" && typeof status !== "boolean") {
    return "";
  }
  return String(status).trim().toLowerCase();
}

export interface McpToolResult {
  isError?: boolean;
  structuredContent?: {
    status?: string;
    action?: string;
    [key: string]: unknown;
  };
  content?: Array<{
    type: string;
    text?: string;
    data?: unknown;
    resource?: { uri?: string; text?: string };
  }>;
}

export function didToolSucceed(result: McpToolResult | undefined | null): boolean {
  if (!result || typeof result !== "object") {
    return false;
  }
  if (result.isError) {
    return false;
  }
  const structuredStatus = normalizeStructuredStatus(
    result.structuredContent?.status
  );
  if (structuredStatus === "success") {
    return true;
  }
  if (structuredStatus === "error") {
    return false;
  }
  return true;
}

function formatStructuredValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? `${value}` : String(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => formatStructuredValue(item)).join(", ");
  }
  return JSON.stringify(value);
}

function buildStructuredSummaryLine(
  structuredContent: McpToolResult["structuredContent"]
): string {
  if (!structuredContent || typeof structuredContent !== "object") {
    return "";
  }
  const status = normalizeStructuredStatus(structuredContent.status);
  const action = structuredContent.action ?? "";
  const detailEntries = Object.entries(structuredContent)
    .filter(
      ([key, value]) =>
        key !== "status" && key !== "action" && value !== undefined
    )
    .map(([key, value]) => `${key}=${formatStructuredValue(value)}`);
  const headlineParts: string[] = [];
  if (action) {
    headlineParts.push(action);
  }
  if (status) {
    headlineParts.push(status);
  }
  const headline = headlineParts.join(" - ");
  if (!headline && detailEntries.length === 0) {
    return "";
  }
  if (detailEntries.length === 0) {
    return headline;
  }
  return headline
    ? `${headline}: ${detailEntries.join(", ")}`
    : detailEntries.join(", ");
}

export function formatMcpResult(result: McpToolResult): string {
  const segments: string[] = [];

  const structuredSummary = buildStructuredSummaryLine(result.structuredContent);
  if (result.isError && !structuredSummary) {
    segments.push("ERROR");
  }
  if (structuredSummary) {
    segments.push(structuredSummary);
  }

  if (Array.isArray(result.content)) {
    for (const entry of result.content) {
      switch (entry.type) {
        case "text": {
          segments.push(sanitizeToolText(entry.text));
          break;
        }
        case "json": {
          segments.push(JSON.stringify(entry.data, undefined, 2));
          break;
        }
        case "resource": {
          segments.push(
            `resource(${entry.resource?.uri ?? "unknown"}): ${entry.resource?.text ?? ""}`
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
    segments.push("(no content)");
  }

  const combined = sanitizeToolText(segments.join("\n"));
  return removeScriptNoise(combined, result.isError ?? false);
}

export function safeParseArguments(rawArguments: unknown): Record<string, unknown> {
  if (!rawArguments || (typeof rawArguments === "object" && Object.keys(rawArguments).length === 0)) {
    return {};
  }

  if (typeof rawArguments === "string") {
    try {
      return rawArguments.length > 0 ? (JSON.parse(rawArguments) as Record<string, unknown>) : {};
    } catch {
      throw new Error(`Tool arguments are not valid JSON: ${rawArguments}`);
    }
  }

  return rawArguments as Record<string, unknown>;
}

export function findToolEntry(
  toolInventory: InventoryEntry[],
  toolName: string
): InventoryEntry | undefined {
  return toolInventory.find(
    (entry) => entry.openAi.function.name === toolName
  );
}

function coercePrimitive(value: unknown): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim();
    const lower = trimmed.toLowerCase();
    if (lower === "true") {
      return true;
    }
    if (lower === "false") {
      return false;
    }

    const numeric = Number(trimmed);
    if (!Number.isNaN(numeric) && trimmed !== "") {
      return numeric;
    }
    return trimmed;
  }
  return value;
}

export function normalizeArgumentsForEntry(
  entry: InventoryEntry | undefined,
  rawArguments: Record<string, unknown>
): Record<string, unknown> {
  if (!rawArguments || typeof rawArguments !== "object") {
    return {};
  }

  const allowedKeys = entry?.parameterKeys ?? [];
  const normalized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(rawArguments)) {
    if (!allowedKeys.includes(key)) {
      continue;
    }
    if (value === null || value === undefined || value === "") {
      continue;
    }
    if (
      typeof value === "string" &&
      ["null", "undefined", "none"].includes(value.trim().toLowerCase())
    ) {
      continue;
    }
    if (key === "cpuId") {
      const cleanedId = sanitizeCpuId(value);
      if (cleanedId === undefined) {
        continue;
      }
      normalized[key] = cleanedId;
      continue;
    }
    if (key === "cpuLabel") {
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

export function formatParameterHints(tool: { parameters?: ToolInputSchema }): string {
  const parameters = tool.parameters?.properties ?? {};
  const required = tool.parameters?.required ?? [];

  if (Object.keys(parameters).length === 0) return "";

  return Object.entries(parameters)
    .map(([key, schema]) => {
      const requiredMark = required.includes(key) ? " (required)" : "";
      const type = schema.type || "string";
      const desc = schema.description ? ` - ${schema.description}` : "";
      return `  - ${key}: ${type}${requiredMark}${desc}`;
    })
    .join("\n");
}

export function findToolMatch(
  input: string,
  lowerNameMap: Map<string, string>
): string | undefined {
  const lower = input.toLowerCase().replaceAll(/[\s-]/g, "_");

  if (lowerNameMap.has(lower)) {
    return lowerNameMap.get(lower);
  }

  for (const [key, value] of lowerNameMap) {
    if (key.startsWith(lower) || lower.startsWith(key)) {
      return value;
    }
  }

  for (const [key, value] of lowerNameMap) {
    const fragments = key.split("_");
    if (fragments.includes(lower)) {
      return value;
    }
  }

  for (const [key, value] of lowerNameMap) {
    if (levenshteinDistance(lower, key) === 1) {
      return value;
    }
  }

  return undefined;
}
