export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "dontAsk"
  | "bypassPermissions";

export type PermissionKind = "read" | "edit" | "shell" | "network";

export type ShellCommandSemantics = "readOnly" | "mutating" | "unknown";

export type PermissionGrantProposal =
  | {
    scope: "session";
    key: string;
    label: string;
  }
  | {
    scope: "persistent";
    key: string;
    rule: string;
    label: string;
  };

export type ToolPermissionDescriptor =
  | {
    permissionKind: Exclude<PermissionKind, "shell">;
    permissionTarget: string;
    grant?: PermissionGrantProposal;
  }
  | {
    permissionKind: "shell";
    permissionTarget: string;
    shellSemantics: ShellCommandSemantics;
    grant?: PermissionGrantProposal;
  };

export type PermissionRequest = ToolPermissionDescriptor & {
  toolName: string;
  input: Record<string, unknown>;
  cwd: string;
  signal?: AbortSignal;
};

export type PermissionDecision =
  | { behavior: "allow" }
  | { behavior: "ask"; reason: string; rememberable: boolean }
  | { behavior: "deny"; reason: string; grantable?: boolean };

export type PermissionAuthorization =
  | { allowed: true }
  | { allowed: false; reason: string };

export type PermissionPolicy = {
  evaluate(
    request: PermissionRequest,
  ): PermissionDecision | Promise<PermissionDecision>;
};

export type PermissionPromptResult =
  | { action: "allow"; remember: boolean }
  | { action: "deny"; feedback?: string };

export type PermissionPrompter = {
  prompt(
    request: PermissionRequest,
    reason: string,
    options: { canRemember: boolean },
  ): Promise<PermissionPromptResult>;
};
