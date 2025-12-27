import type { OllamaMessage } from "../types.js";

export function truncateMiddle(text: string | undefined | null, limit: number): string {
  if (!text || text.length <= limit) return text ?? "";

  const startLength = Math.floor(limit * 0.6);
  const endLength = limit - startLength - 5;

  const start = text.slice(0, startLength);
  const end = text.slice(-endLength);
  return `${start} ... ${end}`;
}

export function flattenWhitespace(text: string | undefined | null): string {
  return text ? text.replaceAll(/\s+/g, " ").trim() : "";
}

export function extractAssistantText(message: OllamaMessage | undefined | null): string {
  if (!message) {
    return "";
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    return (message.content as Array<{ text?: string }>)
      .filter((entry): entry is { text: string } => entry !== null && typeof entry.text === "string")
      .map((entry) => entry.text)
      .join("\n");
  }
  return "";
}

export function levenshteinDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];
  for (let index = 0; index <= b.length; index++) {
    matrix[index] = [index];
  }
  for (let index = 0; index <= a.length; index++) {
    matrix[0]![index] = index;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = b.charAt(i - 1) === a.charAt(j - 1) ? 0 : 1;
      matrix[i]![j] = Math.min(
        matrix[i - 1]![j - 1]! + cost,
        matrix[i]![j - 1]! + 1,
        matrix[i - 1]![j]! + 1
      );
    }
  }
  return matrix[b.length]![a.length]!;
}

export function sanitizeToolText(text: string | undefined | null): string {
  if (!text) {
    return "(no output)";
  }
  const cleaned = text
    // eslint-disable-next-line no-control-regex
    .replaceAll(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replaceAll(/\r\n?/g, "\n")
    .replaceAll(/[ \t]+\n/g, "\n")
    .replaceAll(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned.length > 0 ? cleaned : "(no output)";
}

export function sanitizeCpuId(value: unknown): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "number") {
    const integer = Math.floor(value);
    return Number.isNaN(integer) || integer < 0 ? undefined : integer;
  }
  if (typeof value !== "string" && typeof value !== "boolean") {
    return undefined;
  }
  const numeric = Number(String(value).trim());
  if (Number.isNaN(numeric)) {
    return undefined;
  }
  const integer = Math.floor(numeric);
  return integer >= 0 ? integer : undefined;
}

export function sanitizeCpuLabel(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return "";
  }
  const raw = String(value).trim();
  if (!raw) {
    return "";
  }
  const lower = raw.toLowerCase();
  if (["default", "auto", "automatic", "first", "any", "none"].includes(lower)) {
    return "";
  }
  const match = raw.match(/\(([^)]+)\)/);
  if (match?.[1]) {
    return match[1].trim();
  }
  return raw;
}

export function removeScriptNoise(text: string, isError: boolean): string {
  if (isError) {
    return text;
  }
  const scriptPrefixes = [
    "PRINT",
    "SET",
    "UNTIL",
    "IF ",
    "ELSEIF",
    "ELSE",
    "LOCK",
    "WHEN",
    "ON ",
    "RUN",
    "DECLARE",
  ];
  const lines = text.split("\n");
  const filtered = lines.filter((line) => {
    const trimmed = line.trimStart();
    if (!trimmed) {
      return true;
    }
    return !scriptPrefixes.some((prefix) =>
      trimmed.toUpperCase().startsWith(prefix)
    );
  });
  const cleaned = filtered.join("\n").trim();
  return cleaned.length > 0 ? cleaned : text;
}

export function formatToolListForSpeech(tools: string[]): string {
  if (tools.length === 0) return "no";
  if (tools.length === 1) return tools[0]!.replaceAll("_", " ");
  const readable = tools.map((t) => t.replaceAll("_", " "));
  return readable.slice(0, -1).join(", ") + " and " + readable.at(-1)!;
}
