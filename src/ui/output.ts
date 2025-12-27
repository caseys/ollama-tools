import process from "node:process";
import { COLOR_CODES } from "../config/constants.js";
import { colorize } from "./logger.js";

export function blankLine(debugMode: boolean): void {
  if (debugMode) {
    process.stdout.write("\n");
  }
}

export function separator(debugMode: boolean, label = ""): void {
  if (!debugMode) return;
  const line = "─".repeat(10);
  if (label) {
    console.log(colorize(`${line} ${label} ${line}`, COLOR_CODES.toHuman));
  } else {
    console.log(colorize(line, COLOR_CODES.toHuman));
  }
}
