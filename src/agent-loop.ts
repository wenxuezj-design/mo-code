import { pathToFileURL } from "node:url";

import Anthropic from "@anthropic-ai/sdk";

import {
  SYSTEM_PROMPT_TEMPLATE,
  buildSystemPrompt,
  buildUserContextReminder,
  type SystemPromptBlock,
} from "./system-prompt.ts";
import { executeTool, toolDefinitions } from "./tools/index.ts";

// 1. Type definitions
export type Message = Anthropic.MessageParam;
export type ContentBlock = Anthropic.ContentBlockParam;

// 2. Model and tool definitions
const MODEL = "claude-sonnet-4-6";
const SMOOTH_OUTPUT_INTERVAL_MS = 10;

type AgentOptions = {
  baseURL?: string;
  apiKey?: string;
  staticPrompt?: string;
  model?: string;
};

class SmoothTextWriter {
  private characters: string[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ended = false;
  private resolveDrained!: () => void;
  private drained: Promise<void>;
  hasText = false;

  constructor() {
    this.drained = new Promise((resolve) => {
      this.resolveDrained = resolve;
    });
  }

  write(text: string): void {
    const characters = Array.from(text);
    if (characters.length === 0) return;

    this.hasText = true;
    this.characters.push(...characters);
    this.pump();
  }

  finish(): Promise<void> {
    this.ended = true;
    this.resolveIfDrained();
    return this.drained;
  }

  private pump(): void {
    if (this.timer || this.characters.length === 0) return;

    process.stdout.write(this.characters.shift()!);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pump();
      this.resolveIfDrained();
    }, SMOOTH_OUTPUT_INTERVAL_MS);
  }

  private resolveIfDrained(): void {
    if (this.ended && !this.timer && this.characters.length === 0) {
      this.resolveDrained();
    }
  }
}

// 3. Agent Loop
export class Agent {
  private client: Anthropic;
  private messages: Message[] = [];
  private readFileState = new Map<string, number>();
  private systemPrompt: SystemPromptBlock[];
  private userContextReminder: string;
  private model: string;

  constructor(options: AgentOptions = {}) {
    const staticPrompt = options.staticPrompt ?? SYSTEM_PROMPT_TEMPLATE;

    this.client = new Anthropic({
      apiKey: options.apiKey ?? process.env.ANTHROPIC_API_KEY,
      // 只使用项目显式配置的 API Key，避免同时发送环境中继承的 Claude Code Token。
      authToken: null,
      baseURL: options.baseURL ?? process.env.ANTHROPIC_BASE_URL,
    });
    this.systemPrompt = buildSystemPrompt(staticPrompt);
    this.userContextReminder = buildUserContextReminder();
    this.model = options.model ?? process.env.ANTHROPIC_MODEL ?? MODEL;
  }

  getMessages(): Message[] {
    return structuredClone(this.messages);
  }

  getModel(): string {
    return this.model;
  }

  restoreMessages(messages: Message[]): void {
    this.messages = structuredClone(messages);
  }

  private async callAnthropicStream(
    onToolBlockComplete?: (block: Anthropic.ToolUseBlock) => void,
  ): Promise<Anthropic.Message> {
    const writer = new SmoothTextWriter();
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: 4096,
      system: this.systemPrompt,
      tools: toolDefinitions,
      messages: this.messages,
    });

    stream.on("text", (text) => {
      writer.write(text);
    });
    stream.on("streamEvent", (event, snapshot) => {
      if (event.type !== "content_block_stop") return;

      const block = snapshot.content[event.index];
      if (block?.type === "tool_use") {
        onToolBlockComplete?.(block);
      }
    });

    let reply: Anthropic.Message;
    try {
      reply = await stream.finalMessage();
    } finally {
      await writer.finish();
    }

    if (writer.hasText) process.stdout.write("\n");
    return reply;
  }

  async chat(userText: string): Promise<void> {
    const isFirstTurn = this.messages.length === 0;
    if (isFirstTurn) {
      this.messages.push({
        role: "user",
        content: [
          { type: "text", text: this.userContextReminder },
          { type: "text", text: userText },
        ],
      });
    } else {
      this.messages.push({ role: "user", content: userText });
    }

    while (true) {
      const toolUses: Anthropic.ToolUseBlock[] = [];
      const reply = await this.callAnthropicStream((block) => {
        toolUses.push(block);
      });

      this.messages.push({ role: "assistant", content: reply.content });

      if (toolUses.length === 0) return;

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const toolUse of toolUses) {
        console.log(`  -> ${toolUse.name}(${JSON.stringify(toolUse.input)})`);
        const output = await executeTool(
          toolUse.name,
          toolUse.input as Record<string, unknown>,
          { readFileState: this.readFileState },
        );
        results.push({ type: "tool_result", tool_use_id: toolUse.id, content: output });
      }

      this.messages.push({ role: "user", content: results });
    }
  }
}

// 4. CLI entry
async function main() {
  const prompt = process.argv.slice(2).join(" ") || "Read the file greeting.txt and tell me what it says.";
  await new Agent().chat(prompt);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
