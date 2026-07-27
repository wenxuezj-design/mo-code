import test from "node:test";
import assert from "node:assert/strict";

import { startMockLLM } from "../mock/mock-llm.mjs";
import { Agent } from "../src/agent-loop.ts";
import { SYSTEM_PROMPT_TEMPLATE } from "../src/system-prompt.ts";

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
