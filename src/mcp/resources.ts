import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Logger } from "../ui/logger.js";
import { describeError } from "../ui/logger.js";

export interface ResourceReaderDeps {
  agentLog: Logger;
  agentWarn: Logger;
}

export async function readResource(
  client: Client,
  uri: string,
  deps: ResourceReaderDeps
): Promise<unknown> {
  try {
    const result = await client.readResource({ uri });
    const content = result.contents?.[0];
    if (!content) return undefined;

    if (content.mimeType === "application/json" && "text" in content && typeof content.text === "string") {
      return JSON.parse(content.text) as unknown;
    }
    return "text" in content ? content.text : undefined;
  } catch (error) {
    deps.agentWarn(
      `[agent] Failed to read resource ${uri}: ${describeError(error)}`
    );
    return undefined;
  }
}

export function formatStatusResource(status: unknown): string {
  if (!status) return "";

  if (typeof status === "object" && status !== null && "error" in status) {
    return "";
  }

  if (typeof status === "string") {
    return status.trim();
  }

  if (typeof status === "object" && status !== null) {
    const obj = status as Record<string, unknown>;
    const formatted = obj["formatted"];
    if (typeof formatted === "string") return formatted.trim();
    const summary = obj["summary"];
    if (typeof summary === "string") return summary.trim();

    const parts: string[] = [];
    for (const [key, value] of Object.entries(obj)) {
      if (value === null || value === undefined) continue;
      if (typeof value === "object") {
        if (Array.isArray(value)) {
          if (value.length > 0) parts.push(`${key}: ${value.length} items`);
        } else {
          parts.push(`${key}: {...}`);
        }
      } else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        parts.push(`${key}: ${value}`);
      }
    }
    return parts.join(", ");
  }

  return "";
}

export interface FetchStatusResult {
  statusInfo: string;
  error: string | undefined;
}

export async function fetchStatusInfo(
  client: Client | undefined,
  deps: ResourceReaderDeps,
  logPrefix = ""
): Promise<FetchStatusResult> {
  if (!client) return { statusInfo: "", error: undefined };

  const statusData = await readResource(client, "ksp://status", deps);
  if (!statusData) {
    deps.agentLog(`[agent] ${logPrefix}status: readResource returned nothing`);
    return { statusInfo: "", error: "no data" };
  }

  if (
    typeof statusData === "object" &&
    statusData !== null &&
    "error" in statusData
  ) {
    const errorMsg = String((statusData as { error: unknown }).error);
    deps.agentLog(`[agent] ${logPrefix}status error: ${errorMsg}`);
    return { statusInfo: "", error: errorMsg };
  }

  const statusInfo = formatStatusResource(statusData);
  if (!statusInfo) {
    deps.agentLog(
      `[agent] ${logPrefix}status: formatStatusResource returned empty`
    );
  }
  return { statusInfo, error: undefined };
}
