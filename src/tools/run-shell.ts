import { exec } from "node:child_process";

import { analyzeShellCommand } from "./shell-command-semantics.ts";
import type { Tool, ToolExecutionResult } from "./types.ts";

export const runShellTool: Tool = {
  name: "run_shell",
  getPermissionDescriptor: (input, context) => {
    const command = String(input.command ?? "");
    const analysis = analyzeShellCommand(command, context.cwd);
    return {
      permissionKind: "shell",
      permissionTarget: command,
      shellSemantics: analysis.semantics,
      ...(analysis.filesystemAccesses
        ? { filesystemAccesses: analysis.filesystemAccesses }
        : {}),
      // 空命令无法形成合法的 tool(specifier) 规则，因此只允许单次确认。
      ...(command.trim().length > 0
        ? {
          grant: {
            scope: "persistent" as const,
            key: `run_shell:${command}`,
            rule: `run_shell(${escapePermissionRuleLiteral(command)})`,
            label: "在当前项目中不再询问此命令",
          },
        }
        : {}),
    };
  },
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
      cwd: context.cwd,
    }, context.signal);
  },
};

/** 把 Shell 命令中的规则元字符转成普通文本，确保自动授权只精确匹配原命令。 */
function escapePermissionRuleLiteral(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("*", "\\*");
}

export function runShell(
  input: { command: string; timeout?: number; cwd?: string },
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  const timeout = input.timeout || 30000;

  return new Promise((resolve, reject) => {
    try {
      exec(input.command, {
        encoding: "utf-8",
        maxBuffer: 5 * 1024 * 1024,
        timeout,
        cwd: input.cwd,
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
