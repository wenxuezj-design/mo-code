import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// 1. Type definitions
type Message = {
  role: "user" | "assistant";
  content: string | ContentBlock[];
};

type TextBlock = {
  type: "text";
  text: string;
};

type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};

type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
};

type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

type MessageResponse = {
  content: ContentBlock[];
};

// 2. Model, system prompt, and tool definitions
const MODEL = "mock";
const SYSTEM_PROMPT = "You are a tiny coding agent. Use tools when needed.";

const toolDefinitions = [
  {
    name: "read_file",
    description: "Read a local file and return its contents.",
    input_schema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Path to the file to read.",
        },
      },
      required: ["file_path"],
    },
  },
];

// 3. A tiny Anthropic-compatible client
class AnthropicLikeClient {
  private baseURL: string;

  constructor(baseURL: string) {
    this.baseURL = baseURL;
  }

  messages = {
    create: async (request: Record<string, unknown>): Promise<MessageResponse> => {
      const response = await fetch(`${this.baseURL}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        throw new Error(`Mock request failed: ${response.status} ${await response.text()}`);
      }

      return response.json() as Promise<MessageResponse>;
    },
  };
}

// 4. Agent Loop
export class Agent {
  private client: AnthropicLikeClient;
  private messages: Message[] = [];

  constructor(baseURL = process.env.ANTHROPIC_BASE_URL ?? "http://127.0.0.1:3000") {
    this.client = new AnthropicLikeClient(baseURL);
  }

  async chat(userText: string): Promise<void> {
    this.messages.push({ role: "user", content: userText });

    while (true) {
      const request = {
        model: MODEL,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        tools: toolDefinitions,
        messages: this.messages,
      };

      const reply = await this.client.messages.create(request);
      for (const block of reply.content) {
        if (block.type === "text") process.stdout.write(block.text);
      }
      process.stdout.write("\n");

      this.messages.push({ role: "assistant", content: reply.content });

      const toolUses = reply.content.filter((block): block is ToolUseBlock => block.type === "tool_use");
      if (toolUses.length === 0) return;

      const results: ToolResultBlock[] = [];
      for (const toolUse of toolUses) {
        console.log(`  -> ${toolUse.name}(${JSON.stringify(toolUse.input)})`);
        const output = await executeTool(toolUse.name, toolUse.input);
        results.push({ type: "tool_result", tool_use_id: toolUse.id, content: output });
      }

      this.messages.push({ role: "user", content: results });
    }
  }
}

// 5. Tool execution and CLI entry
async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  if (name !== "read_file") return `Unknown tool: ${name}`;
  const filePath = String(input.file_path ?? "");

  try {
    return readFileSync(filePath, "utf-8");
  } catch (error) {
    return `Error reading file: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function main() {
  const prompt = process.argv.slice(2).join(" ") || "Read the file greeting.txt and tell me what it says.";
  await new Agent().chat(prompt);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
