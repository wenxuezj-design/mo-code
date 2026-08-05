import test from "node:test";
import assert from "node:assert/strict";

import { PermissionGate } from "../src/permissions/index.ts";

const request = {
  toolName: "run_shell",
  input: { command: "pnpm test" },
  cwd: "/project",
};

test("PermissionGate 直接通过 allow 结论", async () => {
  let prompted = false;
  const gate = new PermissionGate({
    policy: { evaluate: () => ({ behavior: "allow" }) },
    prompter: {
      confirm: async () => {
        prompted = true;
        return false;
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
      confirm: async () => {
        prompted = true;
        return true;
      },
    },
  });

  assert.deepEqual(await gate.authorize(request), {
    allowed: false,
    reason: "blocked by policy",
  });
  assert.equal(prompted, false);
});

test("PermissionGate 在 ask 时等待确认器并允许执行", async () => {
  let receivedRequest;
  let receivedReason;
  const gate = new PermissionGate({
    policy: {
      evaluate: () => ({ behavior: "ask", reason: "confirmation required" }),
    },
    prompter: {
      confirm: async (value, reason) => {
        receivedRequest = value;
        receivedReason = reason;
        return true;
      },
    },
  });

  assert.deepEqual(await gate.authorize(request), { allowed: true });
  assert.equal(receivedRequest, request);
  assert.equal(receivedReason, "confirmation required");
});

test("PermissionGate 在没有确认器时默认拒绝 ask", async () => {
  const gate = new PermissionGate({
    policy: {
      evaluate: () => ({ behavior: "ask", reason: "confirmation required" }),
    },
  });

  assert.deepEqual(await gate.authorize(request), {
    allowed: false,
    reason: "User denied permission: confirmation required",
  });
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

test("PermissionGate 在等待用户确认时响应中断", async () => {
  const controller = new AbortController();
  const gate = new PermissionGate({
    policy: {
      evaluate: () => ({ behavior: "ask", reason: "confirmation required" }),
    },
    prompter: { confirm: () => new Promise(() => {}) },
  });
  const authorization = gate.authorize({ ...request, signal: controller.signal });

  await Promise.resolve();
  controller.abort();

  await assert.rejects(
    authorization,
    (error) => error instanceof Error && error.name === "AbortError",
  );
});
