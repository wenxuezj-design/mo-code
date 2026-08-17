import type {
  PermissionDecision,
  PermissionKind,
  PermissionMode,
  PermissionPolicy,
  PermissionRequest,
} from "./types.ts";

type PermissionBehavior = PermissionDecision["behavior"];

const MODE_BEHAVIORS: Record<
  PermissionMode,
  Record<PermissionKind, PermissionBehavior>
> = {
  default: {
    read: "allow",
    edit: "ask",
    shell: "ask",
    network: "ask",
  },
  acceptEdits: {
    read: "allow",
    edit: "allow",
    shell: "ask",
    network: "ask",
  },
  plan: {
    read: "allow",
    edit: "deny",
    shell: "deny",
    network: "ask",
  },
  dontAsk: {
    read: "allow",
    edit: "deny",
    shell: "deny",
    network: "deny",
  },
  bypassPermissions: {
    read: "allow",
    edit: "allow",
    shell: "allow",
    network: "allow",
  },
};

/** 带权限状态的策略对象，用来读取和修改权限模式 */
export class PermissionModePolicy implements PermissionPolicy {
  private mode: PermissionMode;

  constructor(mode: PermissionMode = "default") {
    this.mode = mode;
  }

  getMode(): PermissionMode {
    return this.mode;
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  evaluate(request: PermissionRequest): PermissionDecision {
    if (
      request.permissionKind === "shell"
      && request.shellSemantics === "readOnly"
    ) {
      return { behavior: "allow" };
    }

    const behavior = MODE_BEHAVIORS[this.mode][request.permissionKind];
    if (behavior === "allow") return { behavior };

    const reason = `Permission mode "${this.mode}" ${
      behavior === "ask" ? "requires confirmation for" : "blocks"
    } ${request.permissionKind} tools`;
    if (behavior === "ask") {
      return { behavior, reason, rememberable: true };
    }

    return {
      behavior,
      reason,
      // dontAsk 只关闭交互；已经得到的运行时授权仍然可以执行。
      grantable: this.mode === "dontAsk",
    };
  }
}
