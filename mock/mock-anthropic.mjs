import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

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

export function startMockAnthropic() {
  let requestIndex = 0;

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
    req.on("end", () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Invalid JSON" } }));
        return;
      }

      const message = messageFromRequest(body, requestIndex++);
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
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mock = await startMockAnthropic();
  console.log(`Mock Anthropic listening on ${mock.url}`);

  const close = async () => {
    await mock.close();
    process.exit(0);
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}
