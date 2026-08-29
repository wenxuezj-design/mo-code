import assert from "node:assert/strict";
import test from "node:test";

import {
  ProjectTrustPromptInterruptedError,
  promptForProjectTrust,
} from "../src/cli/project-trust-prompt.ts";

test("项目信任提示展示授能配置并接受信任", async () => {
  const { terminal, output } = createPromptHarness(["1"]);

  const trusted = await promptForProjectTrust(terminal, {
    trustRoot: "/project",
    allowRules: ["run_shell(pnpm test)"],
    defaultMode: "acceptEdits",
  }, output);

  assert.equal(trusted, true);
  assert.match(output.text, /信任根: \/project/);
  assert.match(output.text, /allow: run_shell\(pnpm test\)/);
  assert.match(output.text, /defaultMode: acceptEdits/);
});

test("项目信任提示允许受限继续且不把限制规则列为授能配置", async () => {
  const { terminal, output } = createPromptHarness(["2"]);

  const trusted = await promptForProjectTrust(terminal, {
    trustRoot: "/project",
    allowRules: [],
  }, output);

  assert.equal(trusted, false);
  assert.match(output.text, /当前未发现权限扩张配置/);
  assert.match(output.text, /deny 和 ask 规则无论是否信任都会生效/);
});

test("项目信任提示遇到无效编号时重新读取", async () => {
  const { terminal, output } = createPromptHarness(["x", "1"]);

  const trusted = await promptForProjectTrust(terminal, {
    trustRoot: "/project",
    allowRules: [],
  }, output);

  assert.equal(trusted, true);
  assert.match(output.text, /请输入 1 或 2/);
  assert.deepEqual(terminal.prompts, ["请选择 [1-2]: ", "请选择 [1-2]: "]);
});

test("项目信任提示被 Ctrl+C 中断时停止等待输入", async () => {
  let interrupt = () => {};
  const terminal = {
    readLine: (_prompt, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    }),
    redisplay() {},
    onInterrupt(listener) {
      interrupt = listener;
      return () => {
        interrupt = () => {};
      };
    },
    close() {},
  };
  const pending = promptForProjectTrust(terminal, {
    trustRoot: "/project",
    allowRules: [],
  }, { write() {} });

  interrupt();

  await assert.rejects(pending, ProjectTrustPromptInterruptedError);
});

function createPromptHarness(lines) {
  const prompts = [];
  const terminal = {
    prompts,
    readLine: async (prompt) => {
      prompts.push(prompt);
      return lines.shift();
    },
    redisplay() {},
    onInterrupt: () => () => {},
    close() {},
  };
  const output = {
    text: "",
    write(text) {
      this.text += text;
    },
  };
  return { terminal, output };
}
