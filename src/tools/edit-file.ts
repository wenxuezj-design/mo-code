import { readFileSync, writeFileSync } from "node:fs";

import type { ToolDef } from "./types.ts";

export const editFileTool: ToolDef = {
  name: "edit_file",
  description: "Edit a file by replacing an exact string match with new content. The old_string must match exactly and be unique.",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "The path to the file to edit" },
      old_string: { type: "string", description: "The exact string to find" },
      new_string: { type: "string", description: "The string to replace it with" },
    },
    required: ["file_path", "old_string", "new_string"],
  },
};

export function editFile(input: {
  file_path: string;
  old_string: string;
  new_string: string;
}): string {
  try {
    if (input.old_string.length === 0) {
      return "Error: old_string must not be empty.";
    }

    const content = readFileSync(input.file_path, "utf-8");
    const count = content.split(input.old_string).length - 1;
    if (count === 0) {
      return `Error: old_string not found in ${input.file_path}`;
    }
    if (count > 1) {
      return `Error: old_string found ${count} times in ${input.file_path}. Must be unique.`;
    }

    const updated = content.split(input.old_string).join(input.new_string);
    writeFileSync(input.file_path, updated);
    return `Successfully edited ${input.file_path}`;
  } catch (error) {
    return `Error editing file: ${error instanceof Error ? error.message : String(error)}`;
  }
}
