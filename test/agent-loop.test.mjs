import { createServer } from "node:http";
import test from "node:test";
import assert from "node:assert/strict";

import { Agent } from "../src/agent-loop.ts";
import { SYSTEM_PROMPT_TEMPLATE } from "../src/system-prompt.ts";

test("Agent 默认发送静态 System Prompt", async () => {
  const [request] = await captureRequests((url) => {
    return new Agent({ baseURL: url }).chat("hello");
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
    return new Agent({ baseURL: url, staticPrompt: "baseline prompt" }).chat("hello");
  });

  assert.equal(request.system[0].text, "baseline prompt");
  assert.deepEqual(request.system[0].cache_control, { type: "ephemeral" });
  assert.match(request.system[1].text, /# Environment/);
});

test("Agent 只在第一条用户消息中注入项目上下文", async () => {
  const requests = await captureRequests(async (url) => {
    const agent = new Agent({ baseURL: url });
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
  const captured = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf-8");
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      captured.push(JSON.parse(raw));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ content: [{ type: "text", text: "done" }] }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    assert.ok(address);
    await run(`http://127.0.0.1:${address.port}`);
    assert.ok(captured.length > 0);
    return captured;
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}
