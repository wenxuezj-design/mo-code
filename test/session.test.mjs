import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";

const testHome = mkdtempSync(join(tmpdir(), "mo-code-session-"));
const originalHome = process.env.HOME;
process.env.HOME = testHome;
const sessionModule = await import("../src/session.ts");
if (originalHome === undefined) {
  delete process.env.HOME;
} else {
  process.env.HOME = originalHome;
}

const sessionDir = join(testHome, ".mo-code", "sessions");
const projectCwd = "/project/current";
const olderSessionId = "550e8400-e29b-41d4-a716-446655440010";
const latestSessionId = "550e8400-e29b-41d4-a716-446655440011";
const otherProjectSessionId = "550e8400-e29b-41d4-a716-446655440012";
const damagedSessionId = "550e8400-e29b-41d4-a716-446655440013";

beforeEach(() => {
  rmSync(sessionDir, { recursive: true, force: true });
});

after(() => {
  rmSync(testHome, { recursive: true, force: true });
});

test("listSessions 返回当前工作目录的会话并按更新时间从新到旧排序", () => {
  writeSession({
    id: olderSessionId,
    cwd: projectCwd,
    updatedAt: "2026-07-14T08:00:00.000Z",
  });
  writeSession({
    id: latestSessionId,
    cwd: projectCwd,
    updatedAt: "2026-07-14T10:00:00.000Z",
  });
  writeSession({
    id: otherProjectSessionId,
    cwd: "/project/other",
    updatedAt: "2026-07-14T11:00:00.000Z",
  });
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, `${damagedSessionId}.jsonl`), "{not-json");

  assert.equal(typeof sessionModule.listSessions, "function");
  const result = sessionModule.listSessions(projectCwd);

  assert.deepEqual(
    result.sessions.map((session) => session.id),
    [latestSessionId, olderSessionId],
  );
  assert.deepEqual(result.skippedFiles, [`${damagedSessionId}.jsonl`]);
});

function writeSession({ id, cwd, updatedAt }) {
  const records = [
    {
      type: "session",
      version: 1,
      id,
      cwd,
      model: "mock",
      createdAt: "2026-07-14T07:00:00.000Z",
    },
    {
      type: "turn",
      timestamp: updatedAt,
      model: "mock",
      messages: [
        { role: "user", content: `question ${id}` },
        { role: "assistant", content: [{ type: "text", text: "answer" }] },
      ],
    },
  ];

  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, `${id}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
}
