import test from "node:test";
import assert from "node:assert/strict";

import { PermissionModePolicy } from "../src/permissions/permission-mode-policy.ts";
import { PermissionRulePolicy } from "../src/permissions/permission-rule-policy.ts";

const EXPECTED_BEHAVIORS = {
  default: ["allow", "ask", "ask"],
  acceptEdits: ["allow", "ask", "ask"],
  plan: ["allow", "deny", "deny"],
  dontAsk: ["allow", "deny", "deny"],
  bypassPermissions: ["allow", "allow", "allow"],
};
const SEMANTICS = ["readOnly", "mutating", "unknown"];

test("Shell 语义与权限模式共同决定默认行为", () => {
  for (const [mode, expected] of Object.entries(EXPECTED_BEHAVIORS)) {
    const policy = createPolicy([], mode);

    for (const [index, shellSemantics] of SEMANTICS.entries()) {
      assert.equal(
        policy.evaluate(request("pwd", shellSemantics)).behavior,
        expected[index],
        `${mode}/${shellSemantics}`,
      );
    }
  }
});

test("显式 deny 和 ask 规则优先于只读 Shell 语义", () => {
  const denyPolicy = createPolicy([
    rule("deny", "run_shell(git status)"),
  ]);
  const askPolicy = createPolicy([
    rule("ask", "run_shell(git status)"),
  ]);
  const planAskPolicy = createPolicy([
    rule("ask", "run_shell(git status)"),
  ], "plan");

  assert.equal(
    denyPolicy.evaluate(request("git status", "readOnly")).behavior,
    "deny",
  );
  assert.equal(
    askPolicy.evaluate(request("git status", "readOnly")).behavior,
    "ask",
  );
  assert.equal(
    planAskPolicy.evaluate(request("git status", "readOnly")).behavior,
    "ask",
  );
});

test("dontAsk 把只读 Shell 命中的 ask 规则转为拒绝", () => {
  const policy = createPolicy([
    rule("ask", "run_shell(git status)"),
  ], "dontAsk");

  assert.equal(
    policy.evaluate(request("git status", "readOnly")).behavior,
    "deny",
  );
});

test("显式 allow 可以放行无法确定语义的 Shell 命令", () => {
  const policy = createPolicy([
    rule("allow", "run_shell(pnpm test)"),
  ]);

  assert.equal(
    policy.evaluate(request("pnpm test", "unknown")).behavior,
    "allow",
  );
});

function createPolicy(rules, mode = "default") {
  return new PermissionRulePolicy(
    rules,
    new PermissionModePolicy(mode),
    ["run_shell"],
  );
}

function rule(behavior, raw) {
  return {
    behavior,
    raw,
    sourceScope: "user",
    sourcePath: "/settings.json",
  };
}

function request(command, shellSemantics) {
  return {
    toolName: "run_shell",
    permissionKind: "shell",
    permissionTarget: command,
    shellSemantics,
    input: { command },
    cwd: "/project",
  };
}
