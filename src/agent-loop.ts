import { pathToFileURL } from "node:url";

import Anthropic from "@anthropic-ai/sdk";

import {
  SYSTEM_PROMPT_TEMPLATE,
  buildSystemPrompt,
  buildUserContextReminder,
  type SystemPromptBlock,
} from "./system-prompt.ts";
import {
  executeTool,
  isToolConcurrencySafe,
  toolDefinitions,
  type ToolContext,
} from "./tools/index.ts";

// 1. Type definitions
export type Message = Anthropic.MessageParam;
export type ContentBlock = Anthropic.ContentBlockParam;

// 2. Model and tool definitions
const MODEL = "claude-sonnet-4-6";
const SMOOTH_OUTPUT_INTERVAL_MS = 10;
const MAX_OUTPUT_TOKENS = 64_000;
const THINKING_BUDGET_TOKENS = 32_000;

type AgentOptions = {
  baseURL?: string;
  apiKey?: string;
  staticPrompt?: string;
  model?: string;
  thinking?: boolean;
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

type ToolExecutor = (
  name: string,
  input: Record<string, unknown>,
  context: ToolContext,
) => Promise<string>;

export class StreamingToolExecutor {
  private toolUses: Anthropic.ToolUseBlock[] = [];
  private earlyExecutions = new Map<string, Promise<string>>();
  private reachedExecutionBarrier = false;
  private context: ToolContext;
  private execute: ToolExecutor;

  constructor(
    context: ToolContext,
    execute: ToolExecutor = executeTool,
  ) {
    this.context = context;
    this.execute = execute;
  }

  accept(block: Anthropic.ToolUseBlock): void {
    this.toolUses.push(block);

    if (!this.isConcurrencySafe(block)) {
      this.reachedExecutionBarrier = true;
      return;
    }

    if (!this.reachedExecutionBarrier) {
      this.earlyExecutions.set(block.id, this.executeBlock(block));
    }
  }

  async finish(): Promise<Anthropic.ToolResultBlockParam[]> {
    const results: Anthropic.ToolResultBlockParam[] = [];
    let index = 0;

    while (index < this.toolUses.length) {
      const toolUse = this.toolUses[index];
      const earlyExecution = this.earlyExecutions.get(toolUse.id);

      if (earlyExecution) {
        this.logToolUse(toolUse);
        results.push(this.toToolResult(toolUse, await earlyExecution));
        index++;
        continue;
      }

      if (!this.isConcurrencySafe(toolUse)) {
        this.logToolUse(toolUse);
        results.push(this.toToolResult(toolUse, await this.executeBlock(toolUse)));
        index++;
        continue;
      }

      const batch: Anthropic.ToolUseBlock[] = [];
      while (
        index < this.toolUses.length
        && this.isConcurrencySafe(this.toolUses[index])
        && !this.earlyExecutions.has(this.toolUses[index].id)
      ) {
        batch.push(this.toolUses[index]);
        index++;
      }

      for (const toolUse of batch) this.logToolUse(toolUse);
      const outputs = await Promise.all(batch.map((toolUse) => this.executeBlock(toolUse)));
      results.push(
        ...batch.map((toolUse, batchIndex) => this.toToolResult(toolUse, outputs[batchIndex])),
      );
    }

    return results;
  }

  private isConcurrencySafe(block: Anthropic.ToolUseBlock): boolean {
    return isToolConcurrencySafe(
      block.name,
      block.input as Record<string, unknown>,
    );
  }

  private executeBlock(block: Anthropic.ToolUseBlock): Promise<string> {
    return this.execute(
      block.name,
      block.input as Record<string, unknown>,
      this.context,
    );
  }

  private logToolUse(block: Anthropic.ToolUseBlock): void {
    console.log(`  -> ${block.name}(${JSON.stringify(block.input)})`);
  }

  private toToolResult(
    block: Anthropic.ToolUseBlock,
    output: string,
  ): Anthropic.ToolResultBlockParam {
    return {
      type: "tool_result",
      tool_use_id: block.id,
      content: output,
    };
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
  private thinkingEnabled: boolean;

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
    this.thinkingEnabled = options.thinking ?? false;
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
    if (this.thinkingEnabled) {
      process.stderr.write("Thinking...\n");
    }

    const writer = new SmoothTextWriter();
    const thinking: Anthropic.ThinkingConfigParam = this.thinkingEnabled
      ? {
          type: "enabled",
          budget_tokens: THINKING_BUDGET_TOKENS,
          display: "omitted",
        }
      : { type: "disabled" };
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      thinking,
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
      const toolExecutor = new StreamingToolExecutor({
        readFileState: this.readFileState,
      });
      const reply = await this.callAnthropicStream((block) => {
        toolExecutor.accept(block);
      });

      this.messages.push({ role: "assistant", content: reply.content });

      const results = await toolExecutor.finish();
      if (results.length === 0) return;

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
