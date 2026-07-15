import test from "node:test";
import assert from "node:assert/strict";

import { createSaveQueue } from "../docs/story/tools/lettering/lib/save-queue.mjs";

test("save queue waits for an in-flight snapshot before persisting the newest snapshot", async () => {
  let releaseFirst;
  const firstCanFinish = new Promise((resolve) => { releaseFirst = resolve; });
  const started = [];
  const finished = [];
  const enqueueSave = createSaveQueue(async (snapshot) => {
    started.push(snapshot);
    if (snapshot === "old") await firstCanFinish;
    finished.push(snapshot);
  });

  const oldSave = enqueueSave("old");
  await Promise.resolve();
  const newestSave = enqueueSave("newest");
  await Promise.resolve();

  assert.deepEqual(started, ["old"]);
  releaseFirst();
  await Promise.all([oldSave, newestSave]);
  assert.deepEqual(started, ["old", "newest"]);
  assert.deepEqual(finished, ["old", "newest"]);
});

test("save queue still persists the newest snapshot after an earlier save fails", async () => {
  const attempted = [];
  const enqueueSave = createSaveQueue(async (snapshot) => {
    attempted.push(snapshot);
    if (snapshot === "old") throw new Error("old save failed");
  });

  await assert.rejects(enqueueSave("old"), /old save failed/);
  await enqueueSave("newest");

  assert.deepEqual(attempted, ["old", "newest"]);
});
