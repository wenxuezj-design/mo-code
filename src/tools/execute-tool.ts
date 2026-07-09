import { editFile } from "./edit-file.ts";
import { grepSearch } from "./grep-search.ts";
import { listFiles } from "./list-files.ts";
import { readFile } from "./read-file.ts";
import { runShell } from "./run-shell.ts";
import { writeFile } from "./write-file.ts";

const MAX_RESULT_CHARS = 50000;

export async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  let result: string;

  switch (name) {
    case "read_file":
      result = readFile({ file_path: String(input.file_path ?? "") });
      break;
    case "write_file":
      result = writeFile({
        file_path: String(input.file_path ?? ""),
        content: String(input.content ?? ""),
      });
      break;
    case "edit_file":
      result = editFile({
        file_path: String(input.file_path ?? ""),
        old_string: String(input.old_string ?? ""),
        new_string: String(input.new_string ?? ""),
      });
      break;
    case "list_files":
      result = await listFiles({
        pattern: String(input.pattern ?? ""),
        path: input.path === undefined ? undefined : String(input.path),
      });
      break;
    case "grep_search":
      result = grepSearch({
        pattern: String(input.pattern ?? ""),
        path: input.path === undefined ? undefined : String(input.path),
        include: input.include === undefined ? undefined : String(input.include),
      });
      break;
    case "run_shell":
      result = runShell({
        command: String(input.command ?? ""),
        timeout: input.timeout === undefined ? undefined : Number(input.timeout),
      });
      break;
    default:
      result = `Unknown tool: ${name}`;
  }

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
