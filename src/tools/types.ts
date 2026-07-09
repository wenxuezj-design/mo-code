export type ToolDef = {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
};

export type ToolHandler = (input: Record<string, unknown>) => Promise<string> | string;
