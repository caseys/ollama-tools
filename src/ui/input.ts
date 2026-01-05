import type { Interface as ReadlineInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { hear, say, setHearMuted, isHearMuted } from "hear-say";
import type { InputResult } from "../types.js";
import type { Logger } from "./logger.js";
import type { TerminalUI } from "./terminal.js";

let voiceBusy = true;
let speechInterruptListener: (() => void) | undefined;
let voicePendingResolve: ((result: InputResult) => void) | undefined;
let lastStreamingLength = 0;

// Track the current stdin listener for pause/resume during clarification prompts
let currentStdinListener: ((data: Buffer) => void) | undefined;

/**
 * Pause the main input's stdin listener.
 * Call this before starting a clarification prompt to avoid conflicts.
 */
export function pauseMainInputListener(): void {
  if (currentStdinListener) {
    stdin.removeListener("data", currentStdinListener);
  }
}

/**
 * Resume the main input's stdin listener.
 * Call this after a clarification prompt completes.
 */
export function resumeMainInputListener(): void {
  if (currentStdinListener) {
    stdin.on("data", currentStdinListener);
  }
}

export function setVoiceBusy(busy: boolean): void {
  voiceBusy = busy;
}

export function formatToolListForSpeech(tools: string[]): string {
  if (tools.length === 0) return "no";
  if (tools.length === 1) return tools[0]!.replaceAll("_", " ");
  const readable = tools.map((t) => t.replaceAll("_", " "));
  return readable.slice(0, -1).join(", ") + " and " + readable.at(-1)!;
}

// Module-level terminalUI reference for voice streaming
let activeTerminalUI: TerminalUI | undefined;

export async function getNextInput(rl: ReadlineInterface | undefined, terminalUI?: TerminalUI): Promise<InputResult> {
  // Store for voice streaming to use
  activeTerminalUI = terminalUI;

  return new Promise((resolve) => {
    voicePendingResolve = resolve;

    // Enhanced mode: use terminal-kit's inputField exclusively
    if (terminalUI?.isEnhancedMode()) {
      void terminalUI.getInput("you> ").then((text: string) => {
        if (voicePendingResolve === resolve) {
          voicePendingResolve = undefined;
          activeTerminalUI = undefined;
          resolve({ source: "keyboard", text: text.trimStart() });
        }
      });
      return;
    }

    // Simple mode: use readline with keystroke handling
    if (!rl) {
      throw new Error("readline required for simple mode");
    }

    const handleKeystroke = (data: Buffer): void => {
      const key = data.toString();
      const line = (rl as unknown as { line: string }).line;

      // Handle backtick: toggle mute
      if (key === "`") {
        const nowMuted = !isHearMuted();
        setHearMuted(nowMuted);

        // Remove backtick from line buffer
        if (line.endsWith("`")) {
          stdout.write("\b \b");
          (rl as unknown as { line: string }).line = line.slice(0, -1);
        }

        // Visual feedback: replace "you" with MUTED/LISTENING
        const indicator = nowMuted ? "MUTED" : "LISTENING";
        const currentLine = (rl as unknown as { line: string }).line;
        stdout.write(`\r\u001B[7m${indicator}>\u001B[0m ${currentLine}`);
        setTimeout(() => {
          const line = (rl as unknown as { line: string }).line;
          // Clear the line and restore normal prompt
          stdout.write(`\r${" ".repeat(indicator.length + 2 + line.length)}\ryou> ${line}`);
        }, 2000);
        return;
      }

      // Strip leading spaces
      if (line && line.startsWith(" ")) {
        // Backspace to remove the space visually
        stdout.write("\b \b");
        (rl as unknown as { line: string }).line = line.slice(1);
        // Flash the prompt
        stdout.write("\r\u001B[7myou> \u001B[0m");
        setTimeout(() => {
          stdout.write("\ryou> ");
        }, 80);
      }
    };

    // Store reference so it can be paused during clarification prompts
    currentStdinListener = handleKeystroke;
    stdin.on("data", handleKeystroke);

    void rl.question("you> ").then((text: string) => {
      stdin.removeListener("data", handleKeystroke);
      currentStdinListener = undefined;  // Clear reference after cleanup
      if (voicePendingResolve === resolve) {
        voicePendingResolve = undefined;
        activeTerminalUI = undefined;
        resolve({ source: "keyboard", text: text.trimStart() });
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

        // Use terminalUI if in enhanced mode, otherwise direct stdout
        if (activeTerminalUI?.isEnhancedMode()) {
          activeTerminalUI.writeToInputLine(line);
        } else {
          stdout.write(`\r${line}${" ".repeat(Math.max(0, lastStreamingLength - line.length))}`);
        }
        lastStreamingLength = line.length;
      }
      return;
    }

    // Final result - clear the streaming line first
    if (lastStreamingLength > 0) {
      if (activeTerminalUI?.isEnhancedMode()) {
        activeTerminalUI.clearInputLine();
      } else {
        stdout.write(`\r${" ".repeat(lastStreamingLength)}\r`);
      }
      lastStreamingLength = 0;
    }

    if (!trimmed) return;

    if (voiceBusy) {
      void sayNow("Hold on, I'm busy.");
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

export function enableSpeechInterrupt(terminalUI?: TerminalUI): void {
  // In enhanced mode, terminal-kit's grabInput handles stdin - adding our own
  // listener causes conflicts (triggers immediately). Skip in enhanced mode.
  if (terminalUI?.isEnhancedMode()) return;

  if (speechInterruptListener) return;

  speechInterruptListener = (): void => {
    void say(false);
    disableSpeechInterrupt();
  };

  stdin.once("data", speechInterruptListener);
}

export function disableSpeechInterrupt(): void {
  if (speechInterruptListener) {
    stdin.removeListener("data", speechInterruptListener);
    speechInterruptListener = undefined;
  }
}

function raiseHand(text: string): void {
  void say(text, { latest: true });
}

function sayResult(text: string): void {
  void say(text, { interrupt: true, clear: true });
}

function sayNow(text: string): void {
  void say(text, { rude: true });
}

export { say, raiseHand, sayResult, sayNow };
