import { dirname } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

import type { ToolDef } from "./types.ts";

export const writeFileTool: ToolDef = {
  name: "write_file",
  description: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does.",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "The path to the file to write" },
      content: { type: "string", description: "The content to write to the file" },
    },
    required: ["file_path", "content"],
  },
};

export function writeFile(input: { file_path: string; content: string }): string {
  try {
    const dir = dirname(input.file_path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    writeFileSync(input.file_path, input.content);
    return `Successfully wrote to ${input.file_path}`;
  } catch (error) {
    return `Error writing file: ${error instanceof Error ? error.message : String(error)}`;
  }
}
