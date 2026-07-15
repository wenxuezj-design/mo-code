import assert from "node:assert/strict";
import test from "node:test";

import { runRepl, runTurn } from "../src/cli/conversation.ts";

test("conversation 模块集中提供单轮对话和 REPL", () => {
  assert.equal(typeof runTurn, "function");
  assert.equal(typeof runRepl, "function");
});
