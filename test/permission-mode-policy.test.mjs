import test from "node:test";
import assert from "node:assert/strict";

import { PermissionModePolicy } from "../src/permissions/index.ts";

const expectedBehaviors = {
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

test("PermissionModePolicy 默认使用 default 模式", () => {
  assert.equal(new PermissionModePolicy().getMode(), "default");
});

test("PermissionModePolicy 按模式和工具类别返回权限结论", () => {
  for (const [mode, kinds] of Object.entries(expectedBehaviors)) {
    const policy = new PermissionModePolicy(mode);

    for (const [kind, behavior] of Object.entries(kinds)) {
      const decision = policy.evaluate(createRequest(kind));
      assert.equal(decision.behavior, behavior, `${mode}/${kind}`);
      if (behavior !== "allow") {
        assert.match(decision.reason, new RegExp(`${mode}.*${kind}`));
      }
    }
  }
});

test("PermissionModePolicy 可以在会话中切换模式", () => {
  const policy = new PermissionModePolicy("default");

  assert.equal(policy.evaluate(createRequest("edit")).behavior, "ask");
  policy.setMode("acceptEdits");

  assert.equal(policy.getMode(), "acceptEdits");
  assert.equal(policy.evaluate(createRequest("edit")).behavior, "allow");
});

function createRequest(permissionKind) {
  return {
    toolName: "example_tool",
    permissionKind,
    permissionTarget: "example-target",
    ...(permissionKind === "shell" ? { shellSemantics: "unknown" } : {}),
    input: {},
    cwd: "/project",
  };
}
