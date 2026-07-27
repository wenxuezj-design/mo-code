import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

/**
不调用真实模型。主要用于测试 Agent Loop 和工具调用。
核心流程：
1. 接收 POST /v1/messages 请求。
2. 检查消息中是否已有 tool_result。
3. 没有 tool_result 时，返回一个 read_file 工具调用。
4. Agent 执行 read_file。
5. Agent 把结果再次发送给 Mock。
6. Mock 返回最终文本。
 * 
 * **/

function findToolResult(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i]?.content;
    if (!Array.isArray(content)) continue;
    const block = content.find((b) => b?.type === "tool_result");
    if (block) return block;
  }
  return null;
}

function findLastToolUse(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i]?.content;
    if (!Array.isArray(content)) continue;
    const block = content.find((b) => b?.type === "tool_use");
    if (block) return block;
  }
  return null;
}

function firstUserText(messages) {
  const message = messages.find((m) => m?.role === "user" && typeof m.content === "string");
  return message?.content ?? "";
}

function filePathFromPrompt(prompt) {
  const match = prompt.match(/(?:[./~]|\b)[\w./~-]+\.[A-Za-z0-9_-]+/);
  return match?.[0] ?? "greeting.txt";
}

function messageFromRequest(body, requestIndex) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const toolResult = findToolResult(messages);

  if (!toolResult) {
    const filePath = filePathFromPrompt(firstUserText(messages));
    return {
      id: `msg_mock_${requestIndex}`,
      type: "message",
      role: "assistant",
      model: body.model ?? "mock",
      content: [
        {
          type: "tool_use",
          id: `toolu_mock_${requestIndex}_0`,
          name: "read_file",
          input: { file_path: filePath },
        },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 20, output_tokens: 5 },
    };
  }

  const toolUse = findLastToolUse(messages);
  const filePath = toolUse?.input?.file_path ?? "the file";
  return {
    id: `msg_mock_${requestIndex}`,
    type: "message",
    role: "assistant",
    model: body.model ?? "mock",
    content: [
      {
        type: "text",
        text: `${filePath} says:\n${toolResult.content}`,
      },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 30, output_tokens: 20 },
  };
}

function completeMessage(message, body, requestIndex) {
  return {
    id: message.id ?? `msg_mock_${requestIndex}`,
    type: "message",
    role: "assistant",
    model: message.model ?? body.model ?? "mock",
    content: message.content ?? [],
    stop_reason: message.stop_reason ?? "end_turn",
    stop_sequence: message.stop_sequence ?? null,
    stop_details: message.stop_details ?? null,
    container: message.container ?? null,
    usage: {
      input_tokens: message.usage?.input_tokens ?? 0,
      output_tokens: message.usage?.output_tokens ?? 0,
    },
  };
}

function splitText(text) {
  const characters = Array.from(text);
  const middle = Math.ceil(characters.length / 2);
  return [
    characters.slice(0, middle).join(""),
    characters.slice(middle).join(""),
  ].filter((part) => part.length > 0);
}

function streamEvents(message) {
  const startMessage = {
    ...message,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { ...message.usage, output_tokens: 0 },
  };
  const events = [
    { type: "message_start", message: startMessage },
  ];

  message.content.forEach((block, index) => {
    if (block.type === "text") {
      events.push({
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      });
      for (const text of splitText(block.text)) {
        events.push({
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text },
        });
      }
    } else if (block.type === "tool_use") {
      events.push({
        type: "content_block_start",
        index,
        content_block: {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: {},
        },
      });
      events.push({
        type: "content_block_delta",
        index,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(block.input),
        },
      });
    } else {
      events.push({
        type: "content_block_start",
        index,
        content_block: block,
      });
    }
    events.push({ type: "content_block_stop", index });
  });

  events.push({
    type: "message_delta",
    delta: {
      stop_reason: message.stop_reason,
      stop_sequence: message.stop_sequence,
    },
    usage: { output_tokens: message.usage.output_tokens },
  });
  events.push({ type: "message_stop" });
  return events;
}

function writeSSE(res, event) {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function writeStream(res, message, options) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  let deltaCount = 0;
  for (const event of streamEvents(message)) {
    writeSSE(res, event);
    if (event.type === "content_block_delta") {
      deltaCount++;
      if (deltaCount === options.streamEndAfterDeltas) {
        res.end();
        return;
      }
      if (options.streamDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, options.streamDelayMs));
      }
    }
  }
  res.end();
}

export function startMockLLM(options = {}) {
  let requestIndex = 0;
  const requests = [];
  const requestHeaders = [];

  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/messages") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }

    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", async () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Invalid JSON" } }));
        return;
      }

      requests.push(body);
      requestHeaders.push(req.headers);
      const message = options.responses?.[requestIndex]
        ?? options.response
        ?? messageFromRequest(body, requestIndex);
      const currentRequestIndex = requestIndex;
      requestIndex++;

      if (body.stream === true) {
        await writeStream(
          res,
          completeMessage(message, body, currentRequestIndex),
          {
            streamDelayMs: options.streamDelayMs ?? 0,
            streamEndAfterDeltas: options.streamEndAfterDeltas,
          },
        );
        return;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(message));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        requests,
        requestHeaders,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mock = await startMockLLM();
  console.log(`Mock LLM listening on ${mock.url}`);

  const close = async () => {
    await mock.close();
    process.exit(0);
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}
