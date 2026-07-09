import { readFileSync } from "node:fs";

import type { Tool } from "./types.ts";

export const readFileTool: Tool = {
  name: "read_file",
  description: "Read the contents of a file. Returns the file content with line numbers.",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "The path to the file to read" },
    },
    required: ["file_path"],
  },
  execute(input) {
    return readFile({ file_path: String(input.file_path ?? "") });
  },
};

export function readFile(input: { file_path: string }): string {
  try {
    const content = readFileSync(input.file_path, "utf-8");
    return content
      .split("\n")
      .map((line, index) => `${String(index + 1).padStart(4)} | ${line}`)
      .join("\n");
  } catch (error) {
    return `Error reading file: ${error instanceof Error ? error.message : String(error)}`;
  }
}
