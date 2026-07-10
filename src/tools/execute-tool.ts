import { tools } from "./registry.ts";
import type { ToolContext } from "./types.ts";

const MAX_RESULT_CHARS = 50000;
const toolMap = new Map(tools.map((tool) => [tool.name, tool]));

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  context: ToolContext = { readFileState: new Map() },
): Promise<string> {
  const tool = toolMap.get(name);
  if (!tool) return `Unknown tool: ${name}`;

  const validation = await tool.validateInput?.(input, context);
  if (validation && !validation.ok) return validation.message;

  const result = await tool.execute(input, context);
  return truncateResult(result);
}

function truncateResult(result: string): string {
  if (result.length <= MAX_RESULT_CHARS) return result;

  const keepEach = Math.floor((MAX_RESULT_CHARS - 60) / 2);
  return (
    result.slice(0, keepEach) +
    `\n\n[... truncated ${result.length - keepEach * 2} chars ...]\n\n` +
    result.slice(-keepEach)
  );
}
