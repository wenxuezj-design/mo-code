import { PassThrough } from "node:stream";

import assert from "node:assert/strict";
import test from "node:test";

import { ReadlineTerminalInput } from "../src/cli/terminal-input.ts";

function createTerminal() {
  const input = new PassThrough();
  const output = new PassThrough();
  let outputText = "";
  output.on("data", (chunk) => {
    outputText += chunk.toString();
  });
  return {
    input,
    output,
    terminal: new ReadlineTerminalInput({ input, output }),
    getOutput: () => outputText,
  };
}

test("统一终端输入器按顺序读取行并输出各自提示", async () => {
  const { input, terminal, getOutput } = createTerminal();

  const first = terminal.readLine("> ");
  input.write("hello\n");
  assert.equal(await first, "hello");

  const second = terminal.readLine("请选择: ");
  input.write("2\n");
  assert.equal(await second, "2");
  assert.equal(getOutput(), "> 请选择: ");

  terminal.close();
});

test("输入结束时 readLine 返回 undefined", async () => {
  const { input, terminal } = createTerminal();

  const pending = terminal.readLine("> ");
  input.end();

  assert.equal(await pending, undefined);
  terminal.close();
});

test("中断等待不会关闭终端，后续仍能继续读取", async () => {
  const { input, terminal } = createTerminal();
  const controller = new AbortController();
  const reason = new Error("interrupted");

  const interrupted = terminal.readLine("请选择: ", controller.signal);
  controller.abort(reason);
  await assert.rejects(interrupted, reason);

  const next = terminal.readLine("> ");
  input.write("continue\n");
  assert.equal(await next, "continue");

  terminal.close();
});
