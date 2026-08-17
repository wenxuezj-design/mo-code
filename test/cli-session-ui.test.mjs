import assert from "node:assert/strict";
import test from "node:test";

import {
  confirmSessionDeletion,
  reportSkippedSessionFiles,
  selectSession,
  selectSessionToDelete,
} from "../src/cli/session-ui.ts";

test("session-ui 模块集中提供会话终端交互", () => {
  assert.equal(typeof selectSession, "function");
  assert.equal(typeof selectSessionToDelete, "function");
  assert.equal(typeof confirmSessionDeletion, "function");
  assert.equal(typeof reportSkippedSessionFiles, "function");
});
