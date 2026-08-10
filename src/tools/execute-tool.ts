import { tools } from "./registry.ts";
import type {
  ToolContext,
  ToolExecutionResult,
} from "./types.ts";

const MAX_RESULT_CHARS = 50000;
const toolMap = new Map(tools.map((tool) => [tool.name, tool]));

export function isToolConcurrencySafe(
  name: string,
  input: Record<string, unknown>,
): boolean {
  return toolMap.get(name)?.isConcurrencySafe?.(input) ?? false;
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  if (!context?.permissionGate) {
    throw new Error("ToolContext.permissionGate is required");
  }

  context.signal?.throwIfAborted();

  const tool = toolMap.get(name);
  if (!tool) return errorResult(`Unknown tool: ${name}`);

  const validation = await tool.validateInput?.(input, context);
  if (validation && !validation.ok) return errorResult(validation.message);

  /** 得到权限验证后的结果（是否同意，同意会携带结果）*/
  const authorization = await context.permissionGate.authorize({
    toolName: name,
    permissionKind: tool.permissionKind,
    permissionTarget: tool.getPermissionTarget(input, context),
    input,
    cwd: context.cwd,
    signal: context.signal,
  });
  if (!authorization.allowed) {
    return errorResult(`Permission denied: ${authorization.reason}`);
  }

  context.signal?.throwIfAborted();
  const result = await tool.execute(input, context);
  return normalizeResult(result);
}

function normalizeResult(result: string | ToolExecutionResult): ToolExecutionResult {
  if (typeof result === "string") {
    return { content: truncateResult(result), isError: false };
  }
  return { ...result, content: truncateResult(result.content) };
}

function errorResult(content: string): ToolExecutionResult {
  return { content: truncateResult(content), isError: true };
}

/** 截断结果，避免过长 */
function truncateResult(content: string): string {
  if (content.length <= MAX_RESULT_CHARS) return content;

  const keepEach = Math.floor((MAX_RESULT_CHARS - 60) / 2);
  return (
    content.slice(0, keepEach) +
    `\n\n[... truncated ${content.length - keepEach * 2} chars ...]\n\n` +
    content.slice(-keepEach)
  );
}
