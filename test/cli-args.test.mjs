import assert from "node:assert/strict";
import test from "node:test";

import { HELP_TEXT, parseArgs } from "../src/cli/args.ts";

test("args 模块独立提供 CLI 参数解析和帮助文本", () => {
  assert.match(HELP_TEXT, /^Usage: mo-code/);
  assert.deepEqual(
    parseArgs(["--print", "--model", "test-model", "hello", "world"]),
    {
      help: false,
      version: false,
      print: true,
      continueSession: false,
      resume: false,
      deleteSession: false,
      thinking: false,
      allowDangerouslySkipPermissions: false,
      model: "test-model",
      permissionMode: undefined,
      resumeId: undefined,
      deleteSessionId: undefined,
      prompt: "hello world",
    },
  );
});

test("--permission-mode 只接受五种权限模式", () => {
  for (const mode of [
    "default",
    "acceptEdits",
    "plan",
    "dontAsk",
    "bypassPermissions",
  ]) {
    assert.equal(parseArgs(["--permission-mode", mode]).permissionMode, mode);
  }

  assert.throws(
    () => parseArgs(["--permission-mode"]),
    /--permission-mode 缺少模式/,
  );
  assert.throws(
    () => parseArgs(["--permission-mode", "--print"]),
    /--permission-mode 缺少模式/,
  );
  assert.throws(
    () => parseArgs(["--permission-mode", "unknown"]),
    /无效的权限模式: unknown/,
  );
});

test("危险权限参数区分立即启用和只开放后续切换", () => {
  const skipped = parseArgs(["--dangerously-skip-permissions"]);
  assert.equal(skipped.permissionMode, "bypassPermissions");
  assert.equal(skipped.allowDangerouslySkipPermissions, true);

  const allowed = parseArgs(["--allow-dangerously-skip-permissions"]);
  assert.equal(allowed.permissionMode, undefined);
  assert.equal(allowed.allowDangerouslySkipPermissions, true);

  const duplicateBypass = parseArgs([
    "--permission-mode",
    "bypassPermissions",
    "--dangerously-skip-permissions",
  ]);
  assert.equal(duplicateBypass.permissionMode, "bypassPermissions");

  assert.throws(
    () => parseArgs([
      "--permission-mode",
      "plan",
      "--dangerously-skip-permissions",
    ]),
    /不能和其他 --permission-mode 同时使用/,
  );
});

test("已删除的 --mortis 不会落入 Prompt", () => {
  assert.throws(() => parseArgs(["--mortis"]), /未知参数: --mortis/);
});
