import type {
  PermissionAuthorization,
  PermissionPolicy,
  PermissionPrompter,
  PermissionRequest,
} from "./types.ts";

/** 允许所有权限的策略，默认通行 */
export const allowAllPermissionPolicy: PermissionPolicy = {
  evaluate: () => ({ behavior: "allow" }),
};

/** 默认的用户确认器，直接拒绝 */
export const denyByDefaultPermissionPrompter: PermissionPrompter = {
  confirm: async () => false,
};

type PermissionGateOptions = {
  /** 权限策略 */
  policy?: PermissionPolicy;
  /** 用户确认器 */
  prompter?: PermissionPrompter;
};

export class PermissionGate {
  private readonly policy: PermissionPolicy;
  private readonly prompter: PermissionPrompter;

  constructor(options: PermissionGateOptions = {}) {
    this.policy = options.policy ?? allowAllPermissionPolicy;
    this.prompter = options.prompter ?? denyByDefaultPermissionPrompter;
  }

  async authorize(request: PermissionRequest): Promise<PermissionAuthorization> {
    const decision = await waitForPermissionStep(
      () => this.policy.evaluate(request),
      request.signal,
    );

    if (decision.behavior === "allow") return { allowed: true };
    if (decision.behavior === "deny") {
      return { allowed: false, reason: decision.reason };
    }

    const confirmed = await waitForPermissionStep(
      () => this.prompter.confirm(request, decision.reason),
      request.signal,
    );
    if (confirmed) return { allowed: true };

    return {
      allowed: false,
      reason: `User denied permission: ${decision.reason}`,
    };
  }
}

/** 得到一个执行的 Promise */
function waitForPermissionStep<T>(
  /** 真正要执行的权限步骤 */
  start: () => T | PromiseLike<T>,
  /** 当前 Agent 轮次的中断信号 */
  signal?: AbortSignal,
): Promise<T> {
  /** 没有 signal 表示不支持中断，直接执行 */
  if (!signal) return Promise.resolve(start());
  /** 原生实现的方法，如果 singal.aborted 是 true，则直接中断，否则继续执行--signal.abort() 方法会触发这个状态修改，我们使用 Ctrl+C 可以中断当前轮次 */
  signal.throwIfAborted(); 
  const pending = start();

  /** 将 pending 转为 promise，因为它可能是 promise，也可能是普通值 */
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };

    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(pending).then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );

    if (signal.aborted) onAbort();
  });
}
