export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "dontAsk"
  | "bypassPermissions";

export type PermissionKind = "read" | "edit" | "shell" | "network";

export type ShellCommandSemantics = "readOnly" | "mutating" | "unknown";

export type FilesystemOperation = "read" | "write" | "delete";

export type FilesystemAccess = {
  path: string;
  operation: FilesystemOperation;
  recursive?: boolean;
};

export type FilesystemAccessPlan =
  | { status: "known"; accesses: FilesystemAccess[] }
  | {
    status: "unknown";
    accesses?: FilesystemAccess[];
    /** 无法枚举目标，但已知递归删除可能经符号链接到达 root/Home。 */
    catastrophicDeleteRisk?: true;
  };

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

type ToolPermissionDescriptorBase = {
  permissionTarget: string;
  grant?: PermissionGrantProposal;
  filesystemAccesses?: FilesystemAccessPlan;
};

export type ToolPermissionDescriptor = ToolPermissionDescriptorBase & (
  | {
    permissionKind: Exclude<PermissionKind, "shell">;
  }
  | {
    permissionKind: "shell";
    shellSemantics: ShellCommandSemantics;
  }
);

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
