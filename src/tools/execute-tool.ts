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
    default:
      return `Unknown tool: ${name}`;
  }
}
