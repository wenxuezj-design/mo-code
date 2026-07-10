import test from "node:test";
import assert from "node:assert/strict";

import { runShell } from "../../src/tools/run-shell.ts";

test("run_shell 返回命令输出", () => {
  const result = runShell({ command: "printf 'hello shell'" });

  assert.equal(result, "hello shell");
});

test("run_shell 成功但无输出时返回提示", () => {
  const result = runShell({ command: "true" });

  assert.equal(result, "(no output)");
});

test("run_shell 命令失败时返回 stdout 和 stderr", () => {
  const result = runShell({
    command: "printf 'before fail'; printf 'bad news' >&2; exit 2",
  });

  assert.match(result, /^Command failed \(exit code 2\)/);
  assert.match(result, /Stdout: before fail/);
  assert.match(result, /Stderr: bad news/);
});

test("run_shell 命令超时时返回提示", () => {
  const result = runShell({
    command: "sleep 1",
    timeout: 10,
  });

  assert.match(result, /^Command timed out after 10ms/);
});
