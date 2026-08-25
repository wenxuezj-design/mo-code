import { statSync } from "node:fs";

import { resolveToolPath } from "./permission-target.ts";
import type { ToolContext, ValidationResult } from "./types.ts";

type FileMutationAction = "writing" | "editing";

export function validateFileMutation(
  filePath: string,
  action: FileMutationAction,
  context: ToolContext,
): ValidationResult {
  const { readFileState } = context;
  const absPath = resolveToolPath(context.cwd, filePath);
  let currentMtime: number;
  try {
    currentMtime = statSync(absPath).mtimeMs;
  } catch (error) {
    if (isFileNotFound(error)) return { ok: true };
    return {
      ok: false,
      message: `Error: Unable to inspect ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!readFileState.has(absPath)) {
    return {
      ok: false,
      message: `Error: You must read this file before ${action}. Use read_file first.`,
    };
  }

  if (readFileState.get(absPath) !== currentMtime) {
    return {
      ok: false,
      message: `Warning: ${filePath} was modified externally since your last read. Please read_file again before ${action}.`,
    };
  }

  return { ok: true };
}

export function recordFileState(filePath: string, context: ToolContext): string | null {
  const absPath = resolveToolPath(context.cwd, filePath);
  try {
    context.readFileState.set(absPath, statSync(absPath).mtimeMs);
    return null;
  } catch (error) {
    return `Warning: Failed to record file state for ${filePath}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
