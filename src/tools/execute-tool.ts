import { editFile } from "./edit-file.ts";
import { grepSearch } from "./grep-search.ts";
import { listFiles } from "./list-files.ts";
import { readFile } from "./read-file.ts";
import { writeFile } from "./write-file.ts";

export async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "read_file":
      return readFile({ file_path: String(input.file_path ?? "") });
    case "write_file":
      return writeFile({
        file_path: String(input.file_path ?? ""),
        content: String(input.content ?? ""),
      });
    case "edit_file":
      return editFile({
        file_path: String(input.file_path ?? ""),
        old_string: String(input.old_string ?? ""),
        new_string: String(input.new_string ?? ""),
      });
    case "list_files":
      return listFiles({
        pattern: String(input.pattern ?? ""),
        path: input.path === undefined ? undefined : String(input.path),
      });
    case "grep_search":
      return grepSearch({
        pattern: String(input.pattern ?? ""),
        path: input.path === undefined ? undefined : String(input.path),
        include: input.include === undefined ? undefined : String(input.include),
      });
    default:
      return `Unknown tool: ${name}`;
  }
}
