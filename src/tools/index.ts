import { editFileTool } from "./edit-file.ts";
import { grepSearchTool } from "./grep-search.ts";
import { listFilesTool } from "./list-files.ts";
import { readFileTool } from "./read-file.ts";
import { writeFileTool } from "./write-file.ts";

export { executeTool } from "./execute-tool.ts";
export type { ToolDef, ToolHandler } from "./types.ts";

export const toolDefinitions = [
  readFileTool,
  writeFileTool,
  editFileTool,
  listFilesTool,
  grepSearchTool,
];
