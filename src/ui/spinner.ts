import process from "node:process";
import { SPINNER_FRAMES } from "../config/constants.js";
import type { Logger } from "./logger.js";

export interface Spinner {
  start: (message?: string) => void;
  stop: () => void;
  update: (message: string) => void;
}

export function createSpinner(debugMode: boolean, agentLog: Logger): Spinner {
  let spinnerInterval: ReturnType<typeof setInterval> | undefined;
  let spinnerIndex = 0;

  function start(message = "Thinking"): void {
    if (debugMode) return;
    stop();
    spinnerIndex = 0;
    spinnerInterval = setInterval(() => {
      const frame = SPINNER_FRAMES[spinnerIndex++ % SPINNER_FRAMES.length];
      process.stdout.write(`\r${frame} ${message}...`);
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
    if (spinnerInterval && !debugMode) {
      const frame = SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length];
      process.stdout.write(`\r\u001B[K${frame} ${message}`);
    } else if (debugMode) {
      agentLog(`[Progress] ${message}`);
    }
  }

  return { start, stop, update };
}
