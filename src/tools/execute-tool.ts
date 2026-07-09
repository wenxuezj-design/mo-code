import { readFile } from "./read-file.ts";

export async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "read_file":
      return readFile({ file_path: String(input.file_path ?? "") });
    default:
      return `Unknown tool: ${name}`;
  }
}
