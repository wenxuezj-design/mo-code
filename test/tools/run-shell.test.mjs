import test from "node:test";
import assert from "node:assert/strict";

import { runShell } from "../../src/tools/run-shell.ts";

test("run_shell 返回命令输出", async () => {
  const result = await runShell({ command: "printf 'hello shell'" });

  assert.deepEqual(result, { content: "hello shell", isError: false });
});

test("run_shell 成功但无输出时返回提示", async () => {
  const result = await runShell({ command: "true" });

  assert.deepEqual(result, { content: "(no output)", isError: false });
});

test("run_shell 命令失败时返回 stdout 和 stderr", async () => {
  const result = await runShell({
    command: "printf 'before fail'; printf 'bad news' >&2; exit 2",
  });

  assert.equal(result.isError, true);
  assert.match(result.content, /^Command failed \(exit code 2\)/);
  assert.match(result.content, /Stdout: before fail/);
  assert.match(result.content, /Stderr: bad news/);
});

test("run_shell 命令超时时返回提示", async () => {
  const result = await runShell({
    command: "sleep 1",
    timeout: 10,
  });

  assert.equal(result.isError, true);
  assert.match(result.content, /^Command timed out after 10ms/);
});

test("run_shell 启动失败时返回错误结果", async () => {
  const result = await runShell({ command: "\0" });

  assert.equal(result.isError, true);
  assert.match(result.content, /^Error: /);
});

test("run_shell 收到 AbortSignal 后终止命令", async () => {
  const controller = new AbortController();
  const running = runShell({ command: "sleep 10" }, controller.signal);

  controller.abort();

  await assert.rejects(running, (error) => (
    error instanceof Error && error.name === "AbortError"
  ));
});
