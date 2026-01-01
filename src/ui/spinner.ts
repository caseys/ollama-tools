import process from "node:process";
import { SPINNER_FRAMES } from "../config/constants.js";
import type { Logger } from "./logger.js";

export interface Spinner {
  start: (message: string) => void;
  stop: () => void;
  update: (message: string) => void;
}

export interface SpinnerDeps {
  raiseHand?: (text: string) => void;
}

export function createSpinner(debugMode: boolean, agentLog: Logger, deps?: SpinnerDeps): Spinner {
  let spinnerInterval: ReturnType<typeof setInterval> | undefined;
  let spinnerIndex = 0;
  let currentMessage = "";

  function start(message: string): void {
    if (message !== currentMessage) {
      currentMessage = message;
      deps?.raiseHand?.(message);
    }
    if (debugMode) return;
    stop();
    spinnerIndex = 0;
    spinnerInterval = setInterval(() => {
      const frame = SPINNER_FRAMES[spinnerIndex++ % SPINNER_FRAMES.length];
      process.stdout.write(`\r${frame} ${currentMessage}...`);
    }, 80);
  }

  function stop(): void {
    if (spinnerInterval) {
      clearInterval(spinnerInterval);
      spinnerInterval = undefined;
      process.stdout.write("\r\u001B[K");
    }
  }

  function update(message: string): void {
    if (message !== currentMessage) {
      currentMessage = message;
      deps?.raiseHand?.(message);
    }
    if (spinnerInterval && !debugMode) {
      const frame = SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length];
      process.stdout.write(`\r\u001B[K${frame} ${message}`);
    } else if (debugMode) {
      agentLog(`[Progress] ${message}`);
    }
  }

  return { start, stop, update };
}
