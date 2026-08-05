import type {
  PermissionAuthorization,
  PermissionPolicy,
  PermissionPrompter,
  PermissionRequest,
} from "./types.ts";

export const allowAllPermissionPolicy: PermissionPolicy = {
  evaluate: () => ({ behavior: "allow" }),
};

export const denyByDefaultPermissionPrompter: PermissionPrompter = {
  confirm: async () => false,
};

type PermissionGateOptions = {
  policy?: PermissionPolicy;
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

function waitForPermissionStep<T>(
  start: () => T | PromiseLike<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return Promise.resolve(start());
  signal.throwIfAborted();
  const pending = start();

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
