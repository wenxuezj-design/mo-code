import { editFileTool } from "./edit-file.ts";
import { grepSearchTool } from "./grep-search.ts";
import { listFilesTool } from "./list-files.ts";
import { readFileTool } from "./read-file.ts";
import { runShellTool } from "./run-shell.ts";
import { webFetchTool } from "./web-fetch.ts";
import { writeFileTool } from "./write-file.ts";

import type { Tool, ToolDef } from "./types.ts";

export const tools: Tool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  listFilesTool,
  grepSearchTool,
  runShellTool,
  webFetchTool,
];

export const toolDefinitions: ToolDef[] = tools.map(({ execute, ...definition }) => definition);
