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
  readFileState: Map<string, number>;
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
) => Promise<string> | string;

export type Tool = ToolDef & {
  validateInput?: ToolValidator;
  execute: ToolHandler;
};
