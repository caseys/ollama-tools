import process from "node:process";
import { SPINNER_FRAMES } from "../config/constants.js";
import type { Logger } from "./logger.js";
import type { TerminalUI } from "./terminal.js";

export interface Spinner {
  start: (message: string) => void;
  stop: () => void;
  update: (message: string) => void;
}

export interface SpinnerDeps {
  raiseHand?: (text: string) => void;
  terminalUI?: TerminalUI;
}

export function createSpinner(debugMode: boolean, agentLog: Logger, deps?: SpinnerDeps): Spinner {
  let spinnerInterval: ReturnType<typeof setInterval> | undefined;
  let spinnerIndex = 0;
  let currentMessage = "";

  const terminalUI = deps?.terminalUI;
  const useEnhanced = terminalUI?.isEnhancedMode() ?? false;

  function start(message: string): void {
    if (message !== currentMessage) {
      currentMessage = message;
      deps?.raiseHand?.(message);
    }
    if (debugMode) return;

    stop();
    spinnerIndex = 0;

    if (useEnhanced && terminalUI) {
      terminalUI.startSpinner(message);
    } else {
      spinnerInterval = setInterval(() => {
        const frame = SPINNER_FRAMES[spinnerIndex++ % SPINNER_FRAMES.length];
        process.stdout.write(`\r${frame} ${currentMessage}...`);
      }, 80);
    }
  }

  function stop(): void {
    if (useEnhanced && terminalUI) {
      terminalUI.stopSpinner();
    } else if (spinnerInterval !== undefined) {
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

    if (debugMode) {
      agentLog(`[Progress] ${message}`);
      return;
    }

    if (useEnhanced && terminalUI) {
      terminalUI.updateSpinner(message);
    } else if (spinnerInterval !== undefined) {
      const frame = SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length];
      process.stdout.write(`\r\u001B[K${frame} ${message}`);
    }
  }

  return { start, stop, update };
}
