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
      model: "test-model",
      permissionMode: undefined,
      resumeId: undefined,
      deleteSessionId: undefined,
      prompt: "hello world",
    },
  );
});
