import type { Interface as ReadlineInterface } from "node:readline/promises";
import { stdout } from "node:process";
import { hear, say } from "hear-say";
import type { InputResult } from "../types.js";
import type { Logger } from "./logger.js";

let voiceBusy = true;
let voicePendingResolve: ((result: InputResult) => void) | undefined;
let lastStreamingLength = 0;

export function setVoiceBusy(busy: boolean): void {
  voiceBusy = busy;
}

export function formatToolListForSpeech(tools: string[]): string {
  if (tools.length === 0) return "no";
  if (tools.length === 1) return tools[0]!.replaceAll("_", " ");
  const readable = tools.map((t) => t.replaceAll("_", " "));
  return readable.slice(0, -1).join(", ") + " and " + readable.at(-1)!;
}

export async function getNextInput(rl: ReadlineInterface): Promise<InputResult> {
  return new Promise((resolve) => {
    voicePendingResolve = resolve;

    void rl.question("you> ").then((text: string) => {
      if (voicePendingResolve === resolve) {
        voicePendingResolve = undefined;
        resolve({ source: "keyboard", text });
      }
    });
  });
}

export function initVoiceListener(agentLog: Logger): void {
  hear((text: string, _stop: () => void, final: boolean) => {
    const trimmed = text.trim();

    if (!final) {
      // Streaming update - show on you> line, replacing previous
      if (!voiceBusy && voicePendingResolve) {
        const line = `you> ${trimmed}`;
        stdout.write(`\r${line}${" ".repeat(Math.max(0, lastStreamingLength - line.length))}`);
        lastStreamingLength = line.length;
      }
      return;
    }

    // Final result - clear the streaming line first
    if (lastStreamingLength > 0) {
      stdout.write(`\r${" ".repeat(lastStreamingLength)}\r`);
      lastStreamingLength = 0;
    }

    if (!trimmed) return;

    if (voiceBusy) {
      void say("Hold on, I'm busy.");
      agentLog(`[voice] (ignored while busy) "${trimmed}"`);
    } else if (voicePendingResolve) {
      agentLog(`[voice] "${trimmed}"`);
      const resolve = voicePendingResolve;
      voicePendingResolve = undefined;
      resolve({ source: "voice", text: trimmed });
    }
  });
}

export function stopVoiceListener(): void {
  hear(false);
}

export { say };
