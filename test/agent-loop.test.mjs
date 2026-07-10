import { createServer } from "node:http";
import test from "node:test";
import assert from "node:assert/strict";

import { Agent } from "../src/agent-loop.ts";
import { SYSTEM_PROMPT_TEMPLATE } from "../src/system-prompt.ts";

test("Agent 默认发送静态 System Prompt", async () => {
  const request = await captureRequest((url) => new Agent(url).chat("hello"));

  assert.equal(request.system, SYSTEM_PROMPT_TEMPLATE);
});

test("Agent 支持注入基线 Prompt 进行 A/B 评测", async () => {
  const request = await captureRequest((url) => {
    return new Agent(url, "baseline prompt").chat("hello");
  });

  assert.equal(request.system, "baseline prompt");
});

async function captureRequest(run) {
  let captured;
  const server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf-8");
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      captured = JSON.parse(raw);
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
    assert.ok(captured);
    return captured;
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}
