import assert from "node:assert/strict";
import test from "node:test";

import {
  nonInteractivePermissionPrompter,
  TerminalPermissionPrompter,
} from "../src/cli/permission-prompter.ts";

class FakeTerminalInput {
  constructor(inputs) {
    this.inputs = [...inputs];
    this.prompts = [];
    this.signals = [];
  }

  async readLine(prompt, signal) {
    signal?.throwIfAborted();
    this.prompts.push(prompt);
    this.signals.push(signal);
    return this.inputs.shift();
  }

  redisplay() {}

  onInterrupt() {
    return () => {};
  }

  close() {}
}

function createOutput() {
  const chunks = [];
  return {
    chunks,
    write(chunk) {
      chunks.push(chunk);
    },
  };
}

function createRequest(overrides = {}) {
  return {
    toolName: "run_shell",
    input: { command: "pnpm test" },
    cwd: "/project",
    permissionKind: "shell",
    permissionTarget: "pnpm test",
    shellSemantics: "mutating",
    grant: {
      scope: "persistent",
      key: "pnpm test",
      rule: "run_shell(pnpm test)",
      label: "在当前项目中不再询问",
    },
    ...overrides,
  };
}

test("终端确认器显示权限上下文并接受记忆授权", async () => {
  const terminal = new FakeTerminalInput(["2"]);
  const output = createOutput();
  const prompter = new TerminalPermissionPrompter(terminal, output);

  const result = await prompter.prompt(
    createRequest(),
    "Shell command requires confirmation",
    { canRemember: true },
  );

  assert.deepEqual(result, { action: "allow", remember: true });
  assert.deepEqual(terminal.prompts, ["请选择 [1-3]: "]);
  assert.match(output.chunks.join(""), /工具: run_shell/);
  assert.match(output.chunks.join(""), /目标: pnpm test/);
  assert.match(output.chunks.join(""), /原因: Shell command requires confirmation/);
  assert.match(output.chunks.join(""), /2\. 在当前项目中不再询问/);
});

test("终端确认器对无效选择重试，并支持仅允许本次", async () => {
  const terminal = new FakeTerminalInput(["invalid", "1"]);
  const output = createOutput();
  const prompter = new TerminalPermissionPrompter(terminal, output);

  const result = await prompter.prompt(createRequest(), "reason", {
    canRemember: true,
  });

  assert.deepEqual(result, { action: "allow", remember: false });
  assert.deepEqual(terminal.prompts, ["请选择 [1-3]: ", "请选择 [1-3]: "]);
  assert.match(output.chunks.join(""), /请输入 1 到 3 之间的编号/);
});

test("终端确认器拒绝时收集可选反馈", async () => {
  const terminal = new FakeTerminalInput([
    "3",
    "不要运行全部测试，只测试当前文件",
  ]);
  const prompter = new TerminalPermissionPrompter(terminal, createOutput());

  const result = await prompter.prompt(createRequest(), "reason", {
    canRemember: true,
  });

  assert.deepEqual(result, {
    action: "deny",
    feedback: "不要运行全部测试，只测试当前文件",
  });
  assert.equal(terminal.prompts[1], "拒绝原因（可以留空）: ");
});

test("不可记忆的请求只显示单次允许和拒绝", async () => {
  const terminal = new FakeTerminalInput(["2", ""]);
  const output = createOutput();
  const prompter = new TerminalPermissionPrompter(terminal, output);

  const result = await prompter.prompt(createRequest(), "Explicit ask rule", {
    canRemember: false,
  });

  assert.deepEqual(result, { action: "deny" });
  assert.deepEqual(
    terminal.prompts,
    ["请选择 [1-2]: ", "拒绝原因（可以留空）: "],
  );
  assert.doesNotMatch(output.chunks.join(""), /在当前项目中不再询问/);
});

test("终端确认器将中断信号传给正在等待的输入", async () => {
  let receivedSignal;
  const terminal = {
    readLine(_prompt, signal) {
      receivedSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
    redisplay() {},
    onInterrupt() {
      return () => {};
    },
    close() {},
  };
  const controller = new AbortController();
  const reason = new Error("interrupted");
  const prompter = new TerminalPermissionPrompter(terminal, createOutput());

  const pending = prompter.prompt(
    createRequest({ signal: controller.signal }),
    "reason",
    { canRemember: true },
  );
  controller.abort(reason);

  await assert.rejects(pending, reason);
  assert.equal(receivedSignal, controller.signal);
});

test("非交互确认器直接拒绝并说明 --print 不能确认", async () => {
  const result = await nonInteractivePermissionPrompter.prompt(
    createRequest(),
    "reason",
    { canRemember: true },
  );

  assert.equal(result.action, "deny");
  assert.match(result.feedback, /--print mode is non-interactive/);
});
