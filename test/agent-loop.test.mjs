import test from "node:test";
import assert from "node:assert/strict";

import { startMockLLM } from "../mock/mock-llm.mjs";
import { Agent } from "../src/agent-loop.ts";
import { SYSTEM_PROMPT_TEMPLATE } from "../src/system-prompt.ts";

function captureTextWrites(output, onWrite = () => {}) {
  const originalWrite = process.stdout.write;
  process.stdout.write = function (chunk, ...args) {
    if (typeof chunk === "string") {
      output.push(chunk);
      onWrite();
      return true;
    }
    return Reflect.apply(originalWrite, process.stdout, [chunk, ...args]);
  };
  return originalWrite;
}

test("Agent 实时输出文本分片并保存完整消息", { timeout: 2_000 }, async () => {
  const mock = await startMockLLM({
    response: { content: [{ type: "text", text: "streamed" }] },
  });
  const output = [];
  const writeTimes = [];
  let resolveFirstWrite;
  const firstWrite = new Promise((resolve) => {
    resolveFirstWrite = resolve;
  });
  let completed = false;

  const originalWrite = captureTextWrites(output, () => {
    writeTimes.push(performance.now());
    resolveFirstWrite();
  });

  try {
    const agent = new Agent({ baseURL: mock.url, apiKey: "mock" });
    const chat = agent.chat("hello").then(() => {
      completed = true;
    });

    await firstWrite;
    assert.equal(completed, false);
    await chat;

    assert.deepEqual(output, [..."streamed", "\n"]);
    assert.ok(writeTimes.at(-2) - writeTimes[0] >= 50);
    assert.equal(mock.requests[0].stream, true);
    assert.deepEqual(agent.getMessages().at(-1), {
      role: "assistant",
      content: [{ type: "text", text: "streamed" }],
    });
  } finally {
    process.stdout.write = originalWrite;
    await mock.close();
  }
});

test("Agent 遇到无文本响应时不输出空行", async () => {
  const mock = await startMockLLM({ response: { content: [] } });
  const output = [];
  const originalWrite = captureTextWrites(output);

  try {
    await new Agent({ baseURL: mock.url, apiKey: "mock" }).chat("hello");
    assert.deepEqual(output, []);
  } finally {
    process.stdout.write = originalWrite;
    await mock.close();
  }
});

test("Agent 在完整工具调用形成后继续流式请求", async () => {
  const mock = await startMockLLM({
    responses: [
      {
        content: [
          {
            type: "tool_use",
            id: "toolu_mock_0",
            name: "read_file",
            input: { file_path: "package.json" },
          },
          {
            type: "tool_use",
            id: "toolu_mock_1",
            name: "read_file",
            input: { file_path: "AGENTS.md" },
          },
        ],
        stop_reason: "tool_use",
      },
      { content: [{ type: "text", text: "tool done" }] },
    ],
  });
  const output = [];
  const originalWrite = captureTextWrites(output);
  const originalLog = console.log;
  console.log = () => {};

  try {
    const agent = new Agent({ baseURL: mock.url, apiKey: "mock" });
    await agent.chat("read package.json");

    assert.deepEqual(output, [..."tool done", "\n"]);
    assert.equal(mock.requests.length, 2);
    assert.ok(mock.requests.every((request) => request.stream === true));
    assert.deepEqual(
      mock.requests[1].messages.at(-1).content.map((block) => block.tool_use_id),
      ["toolu_mock_0", "toolu_mock_1"],
    );
    assert.deepEqual(agent.getMessages()[1], {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_mock_0",
          name: "read_file",
          input: { file_path: "package.json" },
        },
        {
          type: "tool_use",
          id: "toolu_mock_1",
          name: "read_file",
          input: { file_path: "AGENTS.md" },
        },
      ],
    });
    assert.deepEqual(agent.getMessages().at(-1), {
      role: "assistant",
      content: [{ type: "text", text: "tool done" }],
    });
  } finally {
    process.stdout.write = originalWrite;
    console.log = originalLog;
    await mock.close();
  }
});

test("Agent 在工具调用后原样传回 omitted Thinking block", async () => {
  const thinkingBlock = {
    type: "thinking",
    thinking: "",
    signature: "thinking-signature",
  };
  const mock = await startMockLLM({
    responses: [
      {
        content: [
          thinkingBlock,
          {
            type: "tool_use",
            id: "toolu_thinking_0",
            name: "read_file",
            input: { file_path: "package.json" },
          },
        ],
        stop_reason: "tool_use",
      },
      { content: [{ type: "text", text: "thinking done" }] },
    ],
  });
  const output = [];
  const errors = [];
  const originalWrite = captureTextWrites(output);
  const originalErrorWrite = process.stderr.write;
  const originalLog = console.log;
  process.stderr.write = function (chunk, ...args) {
    if (typeof chunk === "string") {
      errors.push(chunk);
      return true;
    }
    return Reflect.apply(originalErrorWrite, process.stderr, [chunk, ...args]);
  };
  console.log = () => {};

  try {
    const agent = new Agent({
      baseURL: mock.url,
      apiKey: "mock",
      thinking: true,
    });
    await agent.chat("analyze package.json");

    assert.deepEqual(errors, ["Thinking...\n", "Thinking...\n"]);
    assert.deepEqual(output, [..."thinking done", "\n"]);
    assert.deepEqual(mock.requests[0].thinking, {
      type: "enabled",
      budget_tokens: 32_000,
      display: "omitted",
    });
    assert.equal(mock.requests[0].max_tokens, 64_000);
    assert.deepEqual(mock.requests[1].messages[1].content[0], thinkingBlock);
    assert.deepEqual(agent.getMessages()[1].content[0], thinkingBlock);
  } finally {
    process.stdout.write = originalWrite;
    process.stderr.write = originalErrorWrite;
    console.log = originalLog;
    await mock.close();
  }
});

test("Agent 流失败时保留已输出文本但不保存残缺消息", async () => {
  const mock = await startMockLLM({
    response: { content: [{ type: "text", text: "partial" }] },
    streamEndAfterDeltas: 1,
  });
  const output = [];
  const originalWrite = captureTextWrites(output);

  try {
    const agent = new Agent({ baseURL: mock.url, apiKey: "mock" });
    await assert.rejects(agent.chat("hello"), /without producing a Message/);

    assert.deepEqual(output, [..."part"]);
    assert.equal(agent.getMessages().length, 1);
    assert.equal(agent.getMessages()[0].role, "user");
  } finally {
    process.stdout.write = originalWrite;
    await mock.close();
  }
});

test("Agent 默认发送静态 System Prompt", async () => {
  const [request] = await captureRequests((url) => {
    return new Agent({ baseURL: url, apiKey: "mock" }).chat("hello");
  });

  assert.deepEqual(request.system[0], {
    type: "text",
    text: SYSTEM_PROMPT_TEMPLATE,
    cache_control: { type: "ephemeral" },
  });
  assert.equal(request.system[1].type, "text");
  assert.match(request.system[1].text, /# Environment/);
});

test("Agent 支持注入基线 Prompt 进行 A/B 评测", async () => {
  const [request] = await captureRequests((url) => {
    return new Agent({
      baseURL: url,
      apiKey: "mock",
      staticPrompt: "baseline prompt",
    }).chat("hello");
  });

  assert.equal(request.system[0].text, "baseline prompt");
  assert.deepEqual(request.system[0].cache_control, { type: "ephemeral" });
  assert.match(request.system[1].text, /# Environment/);
});

test("Agent 不发送环境中继承的 Anthropic Auth Token", async () => {
  const previousAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const mock = await startMockLLM({
    response: { content: [{ type: "text", text: "done" }] },
  });

  process.env.ANTHROPIC_AUTH_TOKEN = "inherited-token";
  try {
    await new Agent({ baseURL: mock.url, apiKey: "project-key" }).chat("hello");

    assert.equal(mock.requestHeaders[0]["x-api-key"], "project-key");
    assert.equal(mock.requestHeaders[0].authorization, undefined);
  } finally {
    if (previousAuthToken === undefined) {
      delete process.env.ANTHROPIC_AUTH_TOKEN;
    } else {
      process.env.ANTHROPIC_AUTH_TOKEN = previousAuthToken;
    }
    await mock.close();
  }
});

test("Agent 只在第一条用户消息中注入项目上下文", async () => {
  const requests = await captureRequests(async (url) => {
    const agent = new Agent({ baseURL: url, apiKey: "mock" });
    await agent.chat("first message");
    await agent.chat("second message");
  });

  const firstContent = requests[0].messages[0].content;
  assert.equal(firstContent[0].type, "text");
  assert.match(firstContent[0].text, /^<system-reminder>/);
  assert.deepEqual(firstContent[1], { type: "text", text: "first message" });

  assert.equal(requests[1].messages.at(-1).content, "second message");
  assert.equal(
    JSON.stringify(requests[1].messages).match(/<system-reminder>/g)?.length,
    1,
  );
});

async function captureRequests(run) {
  const mock = await startMockLLM({
    response: { content: [{ type: "text", text: "done" }] },
  });

  try {
    await run(mock.url);
    assert.ok(mock.requests.length > 0);
    return mock.requests;
  } finally {
    await mock.close();
  }
}
