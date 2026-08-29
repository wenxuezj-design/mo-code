import type {
  PermissionAuthorization,
  PermissionDecision,
  PermissionGrantProposal,
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
  prompt: async () => ({ action: "deny" }),
};

type PermissionGateOptions = {
  /** 权限策略 */
  policy?: PermissionPolicy;
  /** 用户确认器 */
  prompter?: PermissionPrompter;
  /** 与 Session 共用同一个 Set，新增会话授权会直接写入其中 */
  sessionGrants?: Set<string>;
  /** 将自动生成的 allow 规则写入项目本地配置 */
  persistGrant?: (rule: string) => void | Promise<void>;
  /** 持久授权降级为单次授权时输出警告 */
  onWarning?: (message: string) => void;
};

type AskDecision = Extract<PermissionDecision, { behavior: "ask" }>;

type PendingPrompt = {
  sequence: number;
  request: PermissionRequest;
  decision: AskDecision;
  resolve: (authorization: PermissionAuthorization) => void;
  reject: (reason?: unknown) => void;
  settled: boolean;
  removeAbortListener: () => void;
};

export class PermissionGate {
  private readonly policy: PermissionPolicy;
  private readonly prompter: PermissionPrompter;
  private readonly sessionGrants: Set<string>;
  private readonly persistentGrants = new Set<string>();
  private readonly persistGrant: PermissionGateOptions["persistGrant"];
  private readonly onWarning: PermissionGateOptions["onWarning"];
  private readonly promptQueue: PendingPrompt[] = [];
  private readonly evaluatingSequences = new Set<number>();
  private nextAuthorizationSequence = 0;
  private promptDeferralDepth = 0;
  private isDrainingPrompts = false;

  constructor(options: PermissionGateOptions = {}) {
    this.policy = options.policy ?? allowAllPermissionPolicy;
    this.prompter = options.prompter ?? denyByDefaultPermissionPrompter;
    // 不复制：Agent 和 Gate 需要共享同一份会话授权，才能随 Session 保存。
    this.sessionGrants = options.sessionGrants ?? new Set<string>();
    this.persistGrant = options.persistGrant;
    this.onWarning = options.onWarning;
  }

  async authorize(request: PermissionRequest): Promise<PermissionAuthorization> {
    const sequence = this.nextAuthorizationSequence++;
    this.evaluatingSequences.add(sequence);
    let decision: PermissionDecision;
    try {
      decision = await waitForPermissionStep(
        () => this.policy.evaluate(request),
        request.signal,
      );
    } catch (error) {
      this.evaluatingSequences.delete(sequence);
      this.startDrainingPrompts();
      throw error;
    }

    if (decision.behavior === "allow") {
      this.finishPolicyEvaluation(sequence);
      return { allowed: true };
    }

    // dontAsk 的模式默认拒绝可以被已有授权覆盖；显式 deny 和 plan 硬拒绝没有该标记。
    if (decision.behavior === "deny") {
      if (decision.grantable && this.hasGrant(request.grant)) {
        this.finishPolicyEvaluation(sequence);
        return { allowed: true };
      }
      this.finishPolicyEvaluation(sequence);
      return { allowed: false, reason: decision.reason };
    }

    // 显式 ask 的 rememberable=false，既不读取也不写入授权记忆。
    if (decision.rememberable && this.hasGrant(request.grant)) {
      this.finishPolicyEvaluation(sequence);
      return { allowed: true };
    }

    try {
      // ask 必须先占据队列位置，再释放策略计算标记，避免后调用先弹出。
      const authorization = this.enqueuePrompt(sequence, request, decision);
      this.finishPolicyEvaluation(sequence);
      return authorization;
    } catch (error) {
      this.finishPolicyEvaluation(sequence);
      throw error;
    }
  }

  /** operation 执行期间收集 ask，结束后再按进入队列的顺序显示。 */
  async deferPromptsWhile<T>(operation: () => Promise<T>): Promise<T> {
    this.promptDeferralDepth++;
    try {
      return await operation();
    } finally {
      this.promptDeferralDepth--;
      this.startDrainingPrompts();
    }
  }

  private hasGrant(grant: PermissionGrantProposal | undefined): boolean {
    if (!grant) return false;
    return grant.scope === "session"
      ? this.sessionGrants.has(grant.key)
      : this.persistentGrants.has(grant.key);
  }

  private enqueuePrompt(
    sequence: number,
    request: PermissionRequest,
    decision: AskDecision,
  ): Promise<PermissionAuthorization> {
    request.signal?.throwIfAborted();

    return new Promise<PermissionAuthorization>((resolve, reject) => {
      let item: PendingPrompt;
      const onAbort = () => {
        this.rejectPrompt(item, request.signal?.reason);
      };
      item = {
        sequence,
        request,
        decision,
        resolve,
        reject,
        settled: false,
        removeAbortListener: () => {
          request.signal?.removeEventListener("abort", onAbort);
        },
      };
      request.signal?.addEventListener("abort", onAbort, { once: true });
      this.promptQueue.push(item);
      this.promptQueue.sort((left, right) => left.sequence - right.sequence);
      // abort 可能发生在前面的 throwIfAborted 与监听器注册之间。
      if (request.signal?.aborted) onAbort();
      this.startDrainingPrompts();
    });
  }

  private startDrainingPrompts(): void {
    if (
      this.isDrainingPrompts
      || this.promptDeferralDepth > 0
      || this.promptQueue.length === 0
      || this.hasEarlierPolicyEvaluation(this.promptQueue[0].sequence)
    ) {
      return;
    }

    this.isDrainingPrompts = true;
    void this.drainPrompts().finally(() => {
      this.isDrainingPrompts = false;
      // drain 结束与新请求入队可能发生在同一个微任务边界，需要再检查一次。
      this.startDrainingPrompts();
    });
  }

  private hasEarlierPolicyEvaluation(sequence: number): boolean {
    for (const evaluatingSequence of this.evaluatingSequences) {
      if (evaluatingSequence < sequence) return true;
    }
    return false;
  }

  private finishPolicyEvaluation(sequence: number): void {
    this.evaluatingSequences.delete(sequence);
    this.startDrainingPrompts();
  }

  private async drainPrompts(): Promise<void> {
    while (this.promptDeferralDepth === 0) {
      const item = this.promptQueue.shift();
      if (!item) return;
      if (item.settled) continue;

      try {
        await this.resolvePrompt(item);
      } catch (error) {
        this.rejectPrompt(item, error);
      }
    }
  }

  private async resolvePrompt(item: PendingPrompt): Promise<void> {
    const { request, decision } = item;
    request.signal?.throwIfAborted();

    // 前一个确认可能刚刚创建了相同授权，因此每次真正显示菜单前都要重查。
    if (decision.rememberable && this.hasGrant(request.grant)) {
      this.resolveAuthorization(item, { allowed: true });
      return;
    }

    const canRemember = decision.rememberable && request.grant !== undefined;
    const result = await waitForPermissionStep(
      () => this.prompter.prompt(request, decision.reason, { canRemember }),
      request.signal,
    );
    if (item.settled) return;

    if (result.action === "deny") {
      const feedback = result.feedback?.trim();
      this.resolveAuthorization(item, {
        allowed: false,
        reason: feedback || "User denied this action.",
      });
      return;
    }

    if (result.remember && canRemember) {
      await this.rememberGrant(request);
    }
    this.resolveAuthorization(item, { allowed: true });
  }

  private async rememberGrant(request: PermissionRequest): Promise<void> {
    const grant = request.grant;
    if (!grant) return;

    if (grant.scope === "session") {
      request.signal?.throwIfAborted();
      this.sessionGrants.add(grant.key);
      return;
    }

    try {
      if (!this.persistGrant) {
        throw new Error("persistent permission storage is unavailable");
      }
      await waitForPermissionStep(
        () => this.persistGrant?.(grant.rule),
        request.signal,
      );
      this.persistentGrants.add(grant.key);
    } catch (error) {
      if (request.signal?.aborted) throw error;
      this.reportWarning(
        `Failed to save persistent permission (${getErrorMessage(error)}); `
          + "the current action is allowed once and will ask again next time.",
      );
    }
  }

  private reportWarning(message: string): void {
    try {
      this.onWarning?.(message);
    } catch {
      // 警告输出失败不能改变用户已经作出的单次允许决定。
    }
  }

  private resolveAuthorization(
    item: PendingPrompt,
    authorization: PermissionAuthorization,
  ): void {
    if (item.settled) return;
    item.settled = true;
    item.removeAbortListener();
    item.resolve(authorization);
  }

  private rejectPrompt(item: PendingPrompt, reason: unknown): void {
    if (item.settled) return;
    item.settled = true;
    item.removeAbortListener();
    item.reject(reason);
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
  /** 已经中断时不要开始后续权限步骤。 */
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

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
