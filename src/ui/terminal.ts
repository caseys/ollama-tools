/**
 * Terminal UI abstraction layer.
 *
 * Provides two implementations:
 * - SimpleTerminalUI: Basic console output (for --prompt mode or piped output)
 * - EnhancedTerminalUI: Split-pane with terminal-kit (interactive TTY mode)
 */

import process from "node:process";
import termKit from "terminal-kit";
import { SPINNER_FRAMES, COLOR_CODES, ENABLE_COLOR, type ColorCode } from "../config/constants.js";

const { terminal: term } = termKit;

// === Interface ===

export interface InputResult {
  text: string;
  source: "keyboard" | "voice";
}

export interface TerminalUI {
  /** Initialize the terminal (set up regions, etc.) */
  init(): Promise<void>;

  /** Cleanup terminal state before exit */
  cleanup(): void;

  /** Write a line to the output pane (scrollable area) */
  writeLine(text: string, color?: ColorCode): void;

  /** Write multiple lines to output pane */
  writeLines(lines: string[], color?: ColorCode): void;

  /** Get input from the user (bottom pane in enhanced mode) */
  getInput(prompt: string): Promise<string>;

  /** Start the spinner with a message */
  startSpinner(message: string): void;

  /** Stop and clear the spinner */
  stopSpinner(): void;

  /** Update the spinner message */
  updateSpinner(message: string): void;

  /** Check if running in enhanced mode */
  isEnhancedMode(): boolean;

  /** Clear the input line (for voice streaming updates) */
  clearInputLine(): void;

  /** Write to the input line without newline (for voice streaming) */
  writeToInputLine(text: string): void;
}

// === Simple Terminal UI (current behavior wrapper) ===

class SimpleTerminalUI implements TerminalUI {
  private spinnerInterval: ReturnType<typeof setInterval> | undefined;
  private spinnerIndex = 0;
  private currentMessage = "";
  private debugMode: boolean;

  constructor(debugMode: boolean) {
    this.debugMode = debugMode;
  }

  isEnhancedMode(): boolean {
    return false;
  }

  async init(): Promise<void> {
    // No initialization needed for simple mode
  }

  cleanup(): void {
    this.stopSpinner();
  }

  writeLine(text: string, color?: ColorCode): void {
    if (color && ENABLE_COLOR) {
      console.log(`${color}${text}${COLOR_CODES.reset}`);
    } else {
      console.log(text);
    }
  }

  writeLines(lines: string[], color?: ColorCode): void {
    for (const line of lines) {
      this.writeLine(line, color);
    }
  }

  getInput(_prompt: string): Promise<string> {
    // This is a placeholder - actual input is handled by readline in index.ts
    // The SimpleTerminalUI doesn't take over input handling
    return Promise.reject(new Error("SimpleTerminalUI.getInput should not be called directly"));
  }

  startSpinner(message: string): void {
    if (this.debugMode) return;
    this.stopSpinner();
    this.currentMessage = message;
    this.spinnerIndex = 0;
    this.spinnerInterval = setInterval(() => {
      const frame = SPINNER_FRAMES[this.spinnerIndex++ % SPINNER_FRAMES.length];
      process.stdout.write(`\r${frame} ${this.currentMessage}...`);
    }, 80);
  }

  stopSpinner(): void {
    if (this.spinnerInterval !== undefined) {
      clearInterval(this.spinnerInterval);
      this.spinnerInterval = undefined;
      process.stdout.write("\r\u001B[K");
    }
  }

  updateSpinner(message: string): void {
    this.currentMessage = message;
    if (this.spinnerInterval && !this.debugMode) {
      const frame = SPINNER_FRAMES[this.spinnerIndex % SPINNER_FRAMES.length];
      process.stdout.write(`\r\u001B[K${frame} ${message}`);
    }
  }

  clearInputLine(): void {
    // No-op in simple mode - handled by readline
  }

  writeToInputLine(text: string): void {
    // In simple mode, just write to stdout
    process.stdout.write(text);
  }
}

// === Enhanced Terminal UI (terminal-kit split pane) ===

class EnhancedTerminalUI implements TerminalUI {
  private outputEndRow = 0;  // Last row of scrolling region
  private inputRow = 0;
  private spinnerInterval: ReturnType<typeof setInterval> | undefined;
  private spinnerIndex = 0;
  private currentSpinnerMessage = "";
  private initialized = false;
  private inputHistory: string[] = [];
  private currentPrefix = "";  // Current prefix for inputField (includes spinner when active)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private inputFieldController: any;  // Controller returned by inputField for aborting

  isEnhancedMode(): boolean {
    return true;
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    // Layout: scrolling region rows 1 to (height-1), input prompt at height
    // No separator - keeps it simple like the working pattern
    this.outputEndRow = term.height - 1;
    this.inputRow = term.height;

    // Clear screen and set up scrolling region for output area
    term.clear();
    term.scrollingRegion(1, this.outputEndRow);

    // Enable raw mode for input
    term.grabInput(true);

    // Handle terminal resize
    term.on("resize", (_width: number, height: number) => {
      this.outputEndRow = height - 1;
      this.inputRow = height;
      term.scrollingRegion(1, this.outputEndRow);
    });

    this.initialized = true;
  }

  private writeTextWithColor(text: string, color?: ColorCode): void {
    if (color && ENABLE_COLOR) {
      // Use terminal-kit's chainable color methods
      switch (color) {
        case COLOR_CODES.toLLM:
          term.blue(text);
          return;
        case COLOR_CODES.fromLLM:
          term.green(text);
          return;
        case COLOR_CODES.toTool:
          term.yellow(text);
          return;
        case COLOR_CODES.fromTool:
          term.brightYellow(text);
          return;
        case COLOR_CODES.toHuman:
          term.cyan(text);
          return;
        case COLOR_CODES.warn:
          term.magenta(text);
          return;
        case COLOR_CODES.error:
          term.red(text);
          return;
      }
    }
    term(text);
  }

  cleanup(): void {
    this.stopSpinner();
    if (this.initialized) {
      // Abort any active inputField
      if (this.inputFieldController) {
        this.inputFieldController.abort();
      }
      term.scrollingRegion(1, term.height);  // Reset to full screen
      term.grabInput(false);
      term.moveTo(1, term.height);
      term("\n");
    }
  }

  writeLine(text: string, color?: ColorCode): void {
    if (!this.initialized) {
      console.log(text);
      return;
    }

    // CRITICAL: Save cursor position (where user is typing in inputField)
    term.saveCursor();

    // Move to bottom of scrolling region
    term.moveTo(1, this.outputEndRow);

    // NEWLINE FIRST - pushes old content UP, then write the new message
    term("\n");
    this.writeTextWithColor(text, color);

    // CRITICAL: Restore cursor to where user was typing
    term.restoreCursor();
  }

  writeLines(lines: string[], color?: ColorCode): void {
    for (const line of lines) {
      this.writeLine(line, color);
    }
  }

  async getInput(prompt: string): Promise<string> {
    // Build the full prefix (spinner + prompt if spinner active, otherwise just prompt)
    const fullPrompt = this.currentPrefix ? `${this.currentPrefix}${prompt}` : prompt;

    return new Promise((resolve) => {
      // Position cursor at input line and write prompt
      term.moveTo(1, this.inputRow);
      term.eraseLine();
      term.cyan(fullPrompt);

      // inputField handles the actual input after the prompt
      this.inputFieldController = term.inputField({
        history: this.inputHistory,
      }, (error: Error | undefined, input: string | undefined) => {
        this.inputFieldController = undefined;
        if (!error && input !== undefined) {
          // Add to history if non-empty
          if (input.trim()) {
            this.inputHistory.push(input);
          }
          resolve(input);
        } else {
          resolve("");  // Return empty on error/abort
        }
      });
    });
  }

  startSpinner(message: string): void {
    this.stopSpinner();
    this.currentSpinnerMessage = message;
    this.spinnerIndex = 0;

    this.spinnerInterval = setInterval(() => {
      const frame = SPINNER_FRAMES[this.spinnerIndex++ % SPINNER_FRAMES.length];
      this.currentPrefix = `${frame} ${this.currentSpinnerMessage}... `;

      // Save cursor, update spinner display, restore cursor
      term.saveCursor();
      term.moveTo(1, this.inputRow);
      term.eraseLine();
      term.yellow(this.currentPrefix);
      term.restoreCursor();
    }, 80);
  }

  stopSpinner(): void {
    if (this.spinnerInterval !== undefined) {
      clearInterval(this.spinnerInterval);
      this.spinnerInterval = undefined;
      this.currentPrefix = "";

      if (this.initialized) {
        // Save cursor, clear spinner, restore cursor
        term.saveCursor();
        term.moveTo(1, this.inputRow);
        term.eraseLine();
        term.restoreCursor();
      }
    }
  }

  updateSpinner(message: string): void {
    this.currentSpinnerMessage = message;
    // The interval will pick up the new message on next tick
  }

  clearInputLine(): void {
    if (!this.initialized) return;
    // Abort current inputField if any, clear the line
    if (this.inputFieldController) {
      this.inputFieldController.abort();
      this.inputFieldController = undefined;
    }
    // These modify the input line intentionally, cursor stays there
    term.moveTo(1, this.inputRow);
    term.eraseLine();
  }

  writeToInputLine(text: string): void {
    if (!this.initialized) {
      process.stdout.write(text);
      return;
    }
    // For voice streaming - abort current input and show the text
    // Cursor stays on input line intentionally
    if (this.inputFieldController) {
      this.inputFieldController.abort();
      this.inputFieldController = undefined;
    }
    term.moveTo(1, this.inputRow);
    term.eraseLine();
    term(text);
  }
}

// === Factory ===

export function createTerminalUI(useEnhanced: boolean, debugMode = false): TerminalUI {
  // Use enhanced UI even in debug mode - scrolling regions protect input from output mixing
  if (useEnhanced && process.stdout.isTTY) {
    return new EnhancedTerminalUI();
  }
  return new SimpleTerminalUI(debugMode);
}
