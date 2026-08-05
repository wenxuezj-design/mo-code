import { exec } from "node:child_process";

import type { Tool, ToolExecutionResult } from "./types.ts";

export const runShellTool: Tool = {
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
  execute(input, context) {
    return runShell({
      command: String(input.command ?? ""),
      timeout: input.timeout === undefined ? undefined : Number(input.timeout),
    }, context.signal);
  },
};

export function runShell(
  input: { command: string; timeout?: number },
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  const timeout = input.timeout || 30000;

  return new Promise((resolve, reject) => {
    try {
      exec(input.command, {
        encoding: "utf-8",
        maxBuffer: 5 * 1024 * 1024,
        timeout,
        signal,
        shell: process.platform === "win32" ? "powershell.exe" : "/bin/sh",
      }, (error, stdout, stderr) => {
        if (!error) {
          resolve({ content: stdout || "(no output)", isError: false });
          return;
        }
        if (signal?.aborted) {
          reject(error);
          return;
        }

        const output = `${stdout ? `\nStdout: ${stdout}` : ""}${stderr ? `\nStderr: ${stderr}` : ""}`;
        if (isTimeoutError(error)) {
          resolve({
            content: `Command timed out after ${timeout}ms${output}`,
            isError: true,
          });
          return;
        }

        const exitCode = getExitCode(error);
        if (exitCode !== undefined) {
          resolve({
            content: `Command failed (exit code ${exitCode})${output}`,
            isError: true,
          });
          return;
        }
        resolve({ content: `Error: ${error.message}`, isError: true });
      });
    } catch (error) {
      if (signal?.aborted) {
        reject(error);
        return;
      }
      resolve({ content: `Error: ${getErrorMessage(error)}`, isError: true });
    }
  });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTimeoutError(
  error: {
    code?: string | number;
    killed?: boolean;
    signal?: NodeJS.Signals | null;
  },
): boolean {
  return error.code === "ETIMEDOUT"
    || (error.killed === true && error.signal === "SIGTERM");
}

function getExitCode(
  error: { code?: string | number },
): number | undefined {
  return typeof error.code === "number" ? error.code : undefined;
}
