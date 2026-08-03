import { execFileSync } from "node:child_process";

import type { Tool } from "./types.ts";

export const grepSearchTool: Tool = {
  name: "grep_search",
  description: "Search for a regex pattern in files. Returns matching lines with file paths and line numbers.",
  input_schema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "The regex pattern to search for" },
      path: {
        type: "string",
        description: "Directory or file to search in. Defaults to current directory.",
      },
      include: {
        type: "string",
        description: 'File glob pattern to include (e.g., "*.ts", "*.py")',
      },
    },
    required: ["pattern"],
  },
  isConcurrencySafe: () => true,
  execute(input) {
    return grepSearch({
      pattern: String(input.pattern ?? ""),
      path: input.path === undefined ? undefined : String(input.path),
      include: input.include === undefined ? undefined : String(input.include),
    });
  },
};

export function grepSearch(input: {
  pattern: string;
  path?: string;
  include?: string;
}): string {
  try {
    const args = ["--line-number", "--color=never"];
    if (input.include) args.push("-g", input.include);
    args.push("--", input.pattern);
    args.push(input.path || ".");

    const result = execFileSync("rg", args, {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 10000,
    });

    const lines = result.split("\n").filter(Boolean);
    return lines.slice(0, 100).join("\n") +
      (lines.length > 100 ? `\n... and ${lines.length - 100} more matches` : "");
  } catch (error) {
    if (isExecError(error) && error.status === 1) return "No matches found.";
    if (isExecError(error) && error.code === "ENOENT") {
      return "Error: ripgrep (rg) is not installed.";
    }
    if (isExecError(error) && error.code === "ENOBUFS") {
      return "Error: too many matches to buffer; narrow the pattern, path, or include filter.";
    }
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function isExecError(error: unknown): error is NodeJS.ErrnoException & { status?: number } {
  return typeof error === "object" && error !== null;
}
