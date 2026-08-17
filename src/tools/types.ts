import type {
  PermissionGate,
  ToolPermissionDescriptor,
} from "../permissions/index.ts";

export type ToolDef = {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
};

export type ToolContext = {
  cwd: string;
  permissionGate: PermissionGate;
  readFileState: Map<string, number>;
  signal?: AbortSignal;
};

export type ToolExecutionResult = {
  content: string;
  isError: boolean;
};

export type ValidationResult =
  | { ok: true }
  | { ok: false; message: string };

export type ToolValidator = (
  input: Record<string, unknown>,
  context: ToolContext,
) => Promise<ValidationResult> | ValidationResult;

export type ToolHandler = (
  input: Record<string, unknown>,
  context: ToolContext,
) => Promise<string | ToolExecutionResult> | string | ToolExecutionResult;

export type Tool = ToolDef & {
  getPermissionDescriptor: (
    input: Record<string, unknown>,
    context: ToolContext,
  ) => ToolPermissionDescriptor;
  validateInput?: ToolValidator;
  isConcurrencySafe?: (input: Record<string, unknown>) => boolean;
  execute: ToolHandler;
};
