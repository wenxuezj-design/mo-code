import { execSync } from "node:child_process";

import type { ToolDef } from "./types.ts";

export const runShellTool: ToolDef = {
  name: "run_shell",
  description: "Execute a shell command and return its output. Use this for running tests, installing packages, git operations, etc.",
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to execute" },
      timeout: { type: "number", description: "Timeout in milliseconds (default: 30000)" },
    },
    required: ["command"],
  },
};

export function runShell(input: { command: string; timeout?: number }): string {
  try {
    const result = execSync(input.command, {
      encoding: "utf-8",
      maxBuffer: 5 * 1024 * 1024,
      timeout: input.timeout || 30000,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32" ? "powershell.exe" : "/bin/sh",
    });

    return result || "(no output)";
  } catch (error) {
    const stdout = getOutput(error, "stdout");
    const stderr = getOutput(error, "stderr");
    const output = `${stdout ? `\nStdout: ${stdout}` : ""}${stderr ? `\nStderr: ${stderr}` : ""}`;

    if (isExecError(error) && isTimeoutError(error)) {
      return `Command timed out after ${input.timeout || 30000}ms${output}`;
    }
    if (isExecError(error) && typeof error.status === "number") {
      return `Command failed (exit code ${error.status})${output}`;
    }
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function isTimeoutError(error: NodeJS.ErrnoException & { status?: number | null; signal?: NodeJS.Signals | null }): boolean {
  return error.code === "ETIMEDOUT" || (error.signal === "SIGTERM" && error.status === null);
}

function getOutput(error: unknown, key: "stdout" | "stderr"): string {
  if (!isExecError(error)) return "";
  const output = error[key];
  return Buffer.isBuffer(output) ? output.toString("utf-8") : String(output ?? "");
}

function isExecError(
  error: unknown,
): error is NodeJS.ErrnoException & {
  status?: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: Buffer | string;
  stderr?: Buffer | string;
} {
  return typeof error === "object" && error !== null;
}
