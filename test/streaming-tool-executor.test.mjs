import { createServer } from "node:http";
import test from "node:test";
import assert from "node:assert/strict";

import { startMockLLM } from "../mock/mock-llm.mjs";
import { Agent, StreamingToolExecutor } from "../src/agent-loop.ts";

test("安全工具在 accept 时启动，并按原始顺序返回结果", async () => {
  const execution = createControlledExecution();
  const executor = new StreamingToolExecutor(
    { readFileState: new Map() },
    execution.execute,
  );

  executor.accept(toolUse("read-a", "read_file"));
  executor.accept(toolUse("list-b", "list_files"));

  assert.deepEqual(execution.started, ["read-a", "list-b"]);

  const finishing = executor.finish();
  execution.resolve("list-b", "B");
  execution.resolve("read-a", "A");

  assert.deepEqual(await finishing, [
    { type: "tool_result", tool_use_id: "read-a", content: "A" },
    { type: "tool_result", tool_use_id: "list-b", content: "B" },
  ]);
  assert.deepEqual(execution.started, ["read-a", "list-b"]);
});

test("副作用工具形成屏障，屏障后的连续只读工具组成并行批次", { timeout: 2_000 }, async () => {
  const execution = createControlledExecution();
  const executor = new StreamingToolExecutor(
    { readFileState: new Map() },
    execution.execute,
  );

  executor.accept(toolUse("read-a", "read_file"));
  executor.accept(toolUse("write-b", "write_file"));
  executor.accept(toolUse("read-c", "read_file"));
  executor.accept(toolUse("list-d", "list_files"));

  assert.deepEqual(execution.started, ["read-a"]);

  const finishing = executor.finish();

  execution.resolve("read-a", "A");
  await waitUntil(() => execution.started.includes("write-b"));
  assert.deepEqual(execution.started, ["read-a", "write-b"]);

  execution.resolve("write-b", "B");
  await waitUntil(() => execution.started.includes("list-d"));
  assert.deepEqual(execution.started, ["read-a", "write-b", "read-c", "list-d"]);

  execution.resolve("list-d", "D");
  execution.resolve("read-c", "C");
  assert.deepEqual(await finishing, [
    { type: "tool_result", tool_use_id: "read-a", content: "A" },
    { type: "tool_result", tool_use_id: "write-b", content: "B" },
    { type: "tool_result", tool_use_id: "read-c", content: "C" },
    { type: "tool_result", tool_use_id: "list-d", content: "D" },
  ]);
});

test("中断时保留已完成结果，并为其余工具补齐错误结果", async () => {
  const controller = new AbortController();
  const started = [];
  const executor = new StreamingToolExecutor(
    { readFileState: new Map(), signal: controller.signal },
    (_name, input, context) => {
      const id = String(input.id);
      started.push(id);
      if (id === "read-a") {
        return Promise.resolve({ content: "A", isError: false });
      }

      return new Promise((_resolve, reject) => {
        context.signal?.addEventListener(
          "abort",
          () => reject(context.signal?.reason),
          { once: true },
        );
      });
    },
  );

  executor.accept(toolUse("read-a", "read_file"));
  executor.accept(toolUse("read-b", "read_file"));
  executor.accept(toolUse("write-c", "write_file"));
  await new Promise((resolve) => setImmediate(resolve));

  controller.abort();

  assert.deepEqual(await executor.finish(), [
    { type: "tool_result", tool_use_id: "read-a", content: "A" },
    {
      type: "tool_result",
      tool_use_id: "read-b",
      content: "Interrupted by user.",
      is_error: true,
    },
    {
      type: "tool_result",
      tool_use_id: "write-c",
      content: "Interrupted by user.",
      is_error: true,
    },
  ]);
  assert.deepEqual(started, ["read-a", "read-b"]);
});

test("Agent 在模型流结束前启动已完成内容块中的安全工具", async () => {
  let resolveFetchStarted;
  const fetchStarted = new Promise((resolve) => {
    resolveFetchStarted = resolve;
  });
  const fetchServer = createServer((_request, response) => {
    resolveFetchStarted();
    response.end("fetched");
  });
  await new Promise((resolve) => fetchServer.listen(0, "127.0.0.1", resolve));
  const address = fetchServer.address();
  assert.ok(address && typeof address === "object");

  const mock = await startMockLLM({
    responses: [
      {
        content: [
          {
            type: "tool_use",
            id: "fetch-a",
            name: "web_fetch",
            input: { url: `http://127.0.0.1:${address.port}` },
          },
          { type: "text", text: "still streaming" },
        ],
        stop_reason: "tool_use",
      },
      { content: [{ type: "text", text: "done" }] },
    ],
    streamDelayMs: 20,
  });

  let completed = false;
  try {
    const chat = new Agent({
      baseURL: mock.url,
      apiKey: "mock",
      permissionMode: "bypassPermissions",
      permissionSettings: { rules: [] },
    })
      .chat("fetch")
      .then(() => {
        completed = true;
      });

    await fetchStarted;
    assert.equal(completed, false);
    await chat;
  } finally {
    await mock.close();
    await new Promise((resolve, reject) => {
      fetchServer.close((error) => error ? reject(error) : resolve());
    });
  }
});

function toolUse(id, name) {
  return {
    type: "tool_use",
    id,
    name,
    input: { id },
  };
}

function createControlledExecution() {
  const started = [];
  const pending = new Map();

  return {
    started,
    execute(_name, input) {
      const id = String(input.id);
      started.push(id);
      let resolve;
      const promise = new Promise((complete) => {
        resolve = complete;
      });
      pending.set(id, resolve);
      return promise;
    },
    resolve(id, output) {
      const complete = pending.get(id);
      assert.ok(complete, `${id} has not started`);
      complete({ content: output, isError: false });
    },
  };
}

async function waitUntil(condition) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("condition was not reached");
}
