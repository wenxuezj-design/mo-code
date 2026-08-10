export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "dontAsk"
  | "bypassPermissions";

export type PermissionKind = "read" | "edit" | "shell" | "network";

export type PermissionRequest = {
  toolName: string;
  permissionKind: PermissionKind;
  permissionTarget: string;
  input: Record<string, unknown>;
  cwd: string;
  signal?: AbortSignal;
};

export type PermissionDecision =
  | { behavior: "allow" }
  | { behavior: "ask"; reason: string }
  | { behavior: "deny"; reason: string };

export type PermissionAuthorization =
  | { allowed: true }
  | { allowed: false; reason: string };

export type PermissionPolicy = {
  evaluate(
    request: PermissionRequest,
  ): PermissionDecision | Promise<PermissionDecision>;
};

export type PermissionPrompter = {
  confirm(request: PermissionRequest, reason: string): Promise<boolean>;
};
