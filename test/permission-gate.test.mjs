import test from "node:test";
import assert from "node:assert/strict";

import { PermissionGate } from "../src/permissions/index.ts";

const request = {
  toolName: "run_shell",
  permissionKind: "shell",
  permissionTarget: "pnpm test",
  shellSemantics: "unknown",
  grant: {
    scope: "persistent",
    key: "run_shell:pnpm test",
    rule: "run_shell(pnpm test)",
    label: "remember shell",
  },
  input: { command: "pnpm test" },
  cwd: "/project",
};

test("PermissionGate 直接通过 allow 结论", async () => {
  let prompted = false;
  const gate = new PermissionGate({
    policy: { evaluate: () => ({ behavior: "allow" }) },
    prompter: {
      prompt: async () => {
        prompted = true;
        return { action: "deny" };
      },
    },
  });

  assert.deepEqual(await gate.authorize(request), { allowed: true });
  assert.equal(prompted, false);
});

test("PermissionGate 直接返回 deny 原因", async () => {
  let prompted = false;
  const gate = new PermissionGate({
    policy: {
      evaluate: () => ({ behavior: "deny", reason: "blocked by policy" }),
    },
    prompter: {
      prompt: async () => {
        prompted = true;
        return { action: "allow", remember: false };
      },
    },
  });

  assert.deepEqual(await gate.authorize(request), {
    allowed: false,
    reason: "blocked by policy",
  });
  assert.equal(prompted, false);
});

test("PermissionGate 在 ask 时传入是否可记忆并允许单次执行", async () => {
  let receivedRequest;
  let receivedReason;
  let receivedOptions;
  const gate = new PermissionGate({
    policy: {
      evaluate: () => ({
        behavior: "ask",
        reason: "confirmation required",
        rememberable: true,
      }),
    },
    prompter: {
      prompt: async (value, reason, options) => {
        receivedRequest = value;
        receivedReason = reason;
        receivedOptions = options;
        return { action: "allow", remember: false };
      },
    },
  });

  assert.deepEqual(await gate.authorize(request), { allowed: true });
  assert.equal(receivedRequest, request);
  assert.equal(receivedReason, "confirmation required");
  assert.deepEqual(receivedOptions, { canRemember: true });
});

test("PermissionGate 默认拒绝 ask，并把用户反馈作为拒绝原因", async () => {
  const defaultGate = new PermissionGate({
    policy: { evaluate: () => defaultAsk() },
  });
  assert.deepEqual(await defaultGate.authorize(request), {
    allowed: false,
    reason: "User denied this action.",
  });

  const feedbackGate = new PermissionGate({
    policy: { evaluate: () => defaultAsk() },
    prompter: {
      prompt: async () => ({
        action: "deny",
        feedback: "只告诉我应该运行什么命令",
      }),
    },
  });
  assert.deepEqual(await feedbackGate.authorize(request), {
    allowed: false,
    reason: "只告诉我应该运行什么命令",
  });
});

test("会话授权写入注入的 Set，并允许共享同一 key 的后续工具", async () => {
  const sessionGrants = new Set();
  let promptCount = 0;
  const gate = new PermissionGate({
    policy: { evaluate: () => defaultAsk() },
    sessionGrants,
    prompter: {
      prompt: async () => {
        promptCount++;
        return { action: "allow", remember: true };
      },
    },
  });
  const editRequest = createEditRequest("edit_file", "/project/a.ts");
  const writeRequest = createEditRequest("write_file", "/project/b.ts");

  assert.deepEqual(await gate.authorize(editRequest), { allowed: true });
  assert.deepEqual([...sessionGrants], ["edit:*"]);
  assert.deepEqual(await gate.authorize(writeRequest), { allowed: true });
  assert.equal(promptCount, 1);
});

test("显式 ask 不读取或保存授权记忆", async () => {
  const sessionGrants = new Set(["edit:*"]);
  let receivedOptions;
  const gate = new PermissionGate({
    policy: {
      evaluate: () => ({
        behavior: "ask",
        reason: "explicit ask",
        rememberable: false,
      }),
    },
    sessionGrants,
    prompter: {
      prompt: async (_request, _reason, options) => {
        receivedOptions = options;
        return { action: "allow", remember: true };
      },
    },
  });

  assert.deepEqual(
    await gate.authorize(createEditRequest("edit_file", "/project/a.ts")),
    { allowed: true },
  );
  assert.deepEqual(receivedOptions, { canRemember: false });
  assert.deepEqual([...sessionGrants], ["edit:*"]);
});

test("持久授权成功写入后在当前进程立即生效，但不会进入 Session Set", async () => {
  const sessionGrants = new Set();
  const persisted = [];
  let promptCount = 0;
  const gate = new PermissionGate({
    policy: { evaluate: () => defaultAsk() },
    sessionGrants,
    persistGrant: async (rule) => persisted.push(rule),
    prompter: {
      prompt: async () => {
        promptCount++;
        return { action: "allow", remember: true };
      },
    },
  });

  assert.deepEqual(await gate.authorize(request), { allowed: true });
  assert.deepEqual(await gate.authorize({ ...request }), { allowed: true });
  assert.deepEqual(persisted, ["run_shell(pnpm test)"]);
  assert.equal(promptCount, 1);
  assert.deepEqual([...sessionGrants], []);
});

test("持久授权写入失败时降级为单次允许，并在下次重新询问", async () => {
  const warnings = [];
  let promptCount = 0;
  const gate = new PermissionGate({
    policy: { evaluate: () => defaultAsk() },
    persistGrant: async () => {
      throw new Error("read-only file system");
    },
    onWarning: (message) => warnings.push(message),
    prompter: {
      prompt: async () => {
        promptCount++;
        return { action: "allow", remember: true };
      },
    },
  });

  assert.deepEqual(await gate.authorize(request), { allowed: true });
  assert.deepEqual(await gate.authorize(request), { allowed: true });
  assert.equal(promptCount, 2);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /read-only file system/);
  assert.match(warnings[0], /allowed once/);
});

test("运行时授权覆盖 dontAsk 默认拒绝，但不覆盖普通 deny", async () => {
  const sessionGrants = new Set(["edit:*"]);
  const editRequest = createEditRequest("edit_file", "/project/a.ts");
  const defaultDenyGate = new PermissionGate({
    sessionGrants,
    policy: {
      evaluate: () => ({
        behavior: "deny",
        reason: "dontAsk blocks prompts",
        grantable: true,
      }),
    },
  });
  assert.deepEqual(await defaultDenyGate.authorize(editRequest), { allowed: true });

  const hardDenyGate = new PermissionGate({
    sessionGrants,
    policy: {
      evaluate: () => ({ behavior: "deny", reason: "explicit deny" }),
    },
  });
  assert.deepEqual(await hardDenyGate.authorize(editRequest), {
    allowed: false,
    reason: "explicit deny",
  });
});

test("deferPromptsWhile 等模型流结束后按 FIFO 显示，并在每次显示前重查授权", async () => {
  const stream = deferred();
  const promptedTargets = [];
  const gate = new PermissionGate({
    policy: { evaluate: () => defaultAsk() },
    sessionGrants: new Set(),
    prompter: {
      prompt: async (value) => {
        promptedTargets.push(value.permissionTarget);
        return { action: "allow", remember: true };
      },
    },
  });

  const streaming = gate.deferPromptsWhile(() => stream.promise);
  const first = gate.authorize(createEditRequest("edit_file", "/project/a.ts"));
  const second = gate.authorize(createEditRequest("write_file", "/project/b.ts"));
  await Promise.resolve();
  assert.deepEqual(promptedTargets, []);

  stream.resolve("reply");
  assert.equal(await streaming, "reply");
  assert.deepEqual(await Promise.all([first, second]), [
    { allowed: true },
    { allowed: true },
  ]);
  // 第一个确认记住了 edit，第二个同 key 调用无需再显示菜单。
  assert.deepEqual(promptedTargets, ["/project/a.ts"]);
});

test("不同授权请求在解除延迟后按进入队列的顺序确认", async () => {
  const stream = deferred();
  const promptedTargets = [];
  const gate = new PermissionGate({
    policy: { evaluate: () => defaultAsk() },
    prompter: {
      prompt: async (value) => {
        promptedTargets.push(value.permissionTarget);
        return { action: "allow", remember: false };
      },
    },
  });

  const streaming = gate.deferPromptsWhile(() => stream.promise);
  const first = gate.authorize({ ...request, permissionTarget: "first" });
  const second = gate.authorize({
    ...request,
    permissionTarget: "second",
    grant: {
      ...request.grant,
      key: "run_shell:second",
      rule: "run_shell(second)",
    },
  });
  stream.resolve();

  await streaming;
  await Promise.all([first, second]);
  assert.deepEqual(promptedTargets, ["first", "second"]);
});

test("异步策略完成顺序不同也不会改变权限确认的调用顺序", async () => {
  const firstDecision = deferred();
  const promptedTargets = [];
  const gate = new PermissionGate({
    policy: {
      evaluate: (value) => value.permissionTarget === "first"
        ? firstDecision.promise
        : defaultAsk(),
    },
    prompter: {
      prompt: async (value) => {
        promptedTargets.push(value.permissionTarget);
        return { action: "allow", remember: false };
      },
    },
  });
  const first = gate.authorize({ ...request, permissionTarget: "first" });
  const second = gate.authorize({
    ...request,
    permissionTarget: "second",
    grant: {
      ...request.grant,
      key: "run_shell:second",
      rule: "run_shell(second)",
    },
  });
  await Promise.resolve();
  assert.deepEqual(promptedTargets, []);

  firstDecision.resolve(defaultAsk());
  await Promise.all([first, second]);
  assert.deepEqual(promptedTargets, ["first", "second"]);
});

test("拒绝一个工具只影响当前调用，确认队列会继续处理后续工具", async () => {
  const results = [
    { action: "deny", feedback: "skip first" },
    { action: "allow", remember: false },
  ];
  const gate = new PermissionGate({
    policy: { evaluate: () => defaultAsk() },
    prompter: { prompt: async () => results.shift() },
  });
  const first = gate.authorize({ ...request, permissionTarget: "first" });
  const second = gate.authorize({
    ...request,
    permissionTarget: "second",
    grant: {
      ...request.grant,
      key: "run_shell:second",
      rule: "run_shell(second)",
    },
  });

  assert.deepEqual(await first, { allowed: false, reason: "skip first" });
  assert.deepEqual(await second, { allowed: true });
});

test("PermissionGate 响应已中断的 Signal", async () => {
  const controller = new AbortController();
  let evaluated = false;
  controller.abort();

  await assert.rejects(
    new PermissionGate({
      policy: {
        evaluate: () => {
          evaluated = true;
          return { behavior: "allow" };
        },
      },
    }).authorize({ ...request, signal: controller.signal }),
    (error) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(evaluated, false);
});

test("PermissionGate 在等待策略时响应中断", async () => {
  const controller = new AbortController();
  const gate = new PermissionGate({
    policy: { evaluate: () => new Promise(() => {}) },
  });
  const authorization = gate.authorize({ ...request, signal: controller.signal });

  controller.abort();

  await assert.rejects(
    authorization,
    (error) => error instanceof Error && error.name === "AbortError",
  );
});

test("PermissionGate 在延迟队列和当前确认中都响应中断", async () => {
  const queuedController = new AbortController();
  const stream = deferred();
  let promptCount = 0;
  const gate = new PermissionGate({
    policy: { evaluate: () => defaultAsk() },
    prompter: {
      prompt: () => {
        promptCount++;
        return new Promise(() => {});
      },
    },
  });

  const streaming = gate.deferPromptsWhile(() => stream.promise);
  const queued = gate.authorize({ ...request, signal: queuedController.signal });
  await Promise.resolve();
  queuedController.abort();
  await assert.rejects(
    queued,
    (error) => error instanceof Error && error.name === "AbortError",
  );
  stream.resolve();
  await streaming;
  await Promise.resolve();
  assert.equal(promptCount, 0);

  const activeController = new AbortController();
  const active = gate.authorize({ ...request, signal: activeController.signal });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(promptCount, 1);
  activeController.abort();
  await assert.rejects(
    active,
    (error) => error instanceof Error && error.name === "AbortError",
  );
});

function defaultAsk() {
  return {
    behavior: "ask",
    reason: "confirmation required",
    rememberable: true,
  };
}

function createEditRequest(toolName, permissionTarget) {
  return {
    toolName,
    permissionKind: "edit",
    permissionTarget,
    grant: {
      scope: "session",
      key: "edit:*",
      label: "remember edits",
    },
    input: { file_path: permissionTarget },
    cwd: "/project",
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
