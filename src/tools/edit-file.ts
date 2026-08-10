import { readFileSync, writeFileSync } from "node:fs";

import { recordFileState, validateFileMutation } from "./file-state.ts";
import { normalizePermissionPath } from "./permission-target.ts";
import type { Tool } from "./types.ts";

export const editFileTool: Tool = {
  name: "edit_file",
  permissionKind: "edit",
  getPermissionTarget: (input, context) =>
    normalizePermissionPath(context.cwd, String(input.file_path ?? "")),
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
  validateInput(input, context) {
    return validateFileMutation(String(input.file_path ?? ""), "editing", context);
  },
  execute(input, context) {
    const filePath = String(input.file_path ?? "");
    const result = editFile({
      file_path: filePath,
      old_string: String(input.old_string ?? ""),
      new_string: String(input.new_string ?? ""),
    });
    if (result.startsWith("Successfully")) {
      const warning = recordFileState(filePath, context);
      if (warning) return `${result}\n${warning}`;
    }
    return result;
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
    const normalizedContent = normalizeQuotes(content);
    const normalizedOldString = normalizeQuotes(input.old_string);
    const count = normalizedContent.split(normalizedOldString).length - 1;
    if (count === 0) {
      return `Error: old_string not found in ${input.file_path}`;
    }
    if (count > 1) {
      return `Error: old_string found ${count} times in ${input.file_path}. Must be unique.`;
    }

    const actualOldString = findActualString(content, input.old_string);
    if (!actualOldString) {
      return `Error: old_string not found in ${input.file_path}`;
    }

    const updated = content.split(actualOldString).join(input.new_string);
    writeFileSync(input.file_path, updated);

    const quoteNote = actualOldString !== input.old_string
      ? " (matched via quote normalization)"
      : "";
    return `Successfully edited ${input.file_path}${quoteNote}\n\n${generateDiff(content, actualOldString, input.new_string)}`;
  } catch (error) {
    return `Error editing file: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function normalizeQuotes(value: string): string {
  return value
    .replace(/[\u2018\u2019\u2032]/g, "'")
    .replace(/[\u201C\u201D\u2033]/g, '"');
}

function findActualString(fileContent: string, searchString: string): string | null {
  if (fileContent.includes(searchString)) return searchString;

  const normalizedFile = normalizeQuotes(fileContent);
  const normalizedSearch = normalizeQuotes(searchString);
  const index = normalizedFile.indexOf(normalizedSearch);

  if (index === -1) return null;
  return fileContent.slice(index, index + searchString.length);
}

function generateDiff(content: string, oldString: string, newString: string): string {
  const lineNumber = content.slice(0, content.indexOf(oldString)).split("\n").length;

  return [
    `@@ -${lineNumber},1 +${lineNumber},1 @@`,
    `- ${oldString}`,
    `+ ${newString}`,
  ].join("\n");
}
