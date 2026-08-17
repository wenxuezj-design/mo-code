import { glob } from "glob";

import { normalizePermissionPath } from "./permission-target.ts";
import type { Tool } from "./types.ts";

export const listFilesTool: Tool = {
  name: "list_files",
  getPermissionDescriptor: (input, context) => ({
    permissionKind: "read",
    permissionTarget: normalizePermissionPath(
      context.cwd,
      String(input.path ?? "."),
      String(input.pattern ?? ""),
    ),
  }),
  description: "List files matching a glob pattern. Returns matching file paths.",
  input_schema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: 'Glob pattern to match files (e.g., "**/*.ts", "src/**/*")',
      },
      path: {
        type: "string",
        description: "Base directory to search from. Defaults to current directory.",
      },
    },
    required: ["pattern"],
  },
  isConcurrencySafe: () => true,
  execute(input) {
    return listFiles({
      pattern: String(input.pattern ?? ""),
      path: input.path === undefined ? undefined : String(input.path),
    });
  },
};

export async function listFiles(input: { pattern: string; path?: string }): Promise<string> {
  try {
    const files = await glob(input.pattern, {
      cwd: input.path || process.cwd(),
      nodir: true,
      ignore: ["node_modules/**", ".git/**"],
    });

    if (files.length === 0) {
      return "No files found matching the pattern.";
    }

    return files.slice(0, 200).join("\n");
  } catch (error) {
    return `Error listing files: ${error instanceof Error ? error.message : String(error)}`;
  }
}
