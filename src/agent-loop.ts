import { pathToFileURL } from "node:url";

import Anthropic from "@anthropic-ai/sdk";

import {
  PermissionGate,
  PermissionModePolicy,
  PermissionRulePolicy,
  loadPermissionSettings,
  type LoadedPermissionSettings,
  type PermissionMode,
  type PermissionPrompter,
} from "./permissions/index.ts";
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
  type ToolExecutionResult,
} from "./tools/index.ts";

// 1. Type definitions
export type Message = Anthropic.MessageParam;
export type ContentBlock = Anthropic.ContentBlockParam;
export type ChatResult = "completed" | "interrupted";

/** 用来累计当前 Agent 进程中的 Prompt Cache 使用量 
 * 
* 举个例子，现在新员工入职，我们给他一本100页的行动指南
* 
* 第1次，我们问了他一个问题：告诉我如何报销，他阅读了解相关知识，那么这里 写入就是：100页的信息，命中信息是0，因为之前他并不知道相关问题
* 
* 第2次，我们换了个问题：告诉我如何休假。那么这里他只需要回忆起之前的内容解答就行，所以这次写入是0，命中是100
* 
* 大概是这样，根据问题的相关性，命中的程度也会有所不同，另外要说下是不存在百分比命中的情况，因为提问也属于信息，所以每次都会出现新内容。
* 
* 比如说100页的token是10000，我们提问是20，即使完全命中也是 10000/10020。
* 
* 另外，根据情况，补充新的信息或者信息发生变化也是可能的，可能会变成50页命中信息，30页信息这样
*/
export type PromptCacheUsage = {
  /** 写入新缓存的输入 token 数 */
  creationInputTokens: number;
  /** 命中并读取已有缓存输入的 token 数 */
  readInputTokens: number;
};

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
  permissionMode?: PermissionMode;
  allowDangerouslySkipPermissions?: boolean;
  permissionPrompter?: PermissionPrompter;
  permissionSettings?: LoadedPermissionSettings;
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

  abort(): void {
    this.ended = true;
    this.characters = [];
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.resolveDrained();
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

  /** 平滑文字输出是否彻底结束 */
  private resolveIfDrained(): void {
    // 已经调用结束方法，不会加入新文字
    // 且 没有正在执行的输出定时器
    // 且 待输出的字符串缓冲区已经清空
    if (this.ended && !this.timer && this.characters.length === 0) {
      this.resolveDrained();
    }
  }
}

type ToolExecutor = (
  name: string,
  input: Record<string, unknown>,
  context: ToolContext,
) => Promise<ToolExecutionResult>;

type ToolExecutionOutcome =
  | { status: "completed"; output: ToolExecutionResult }
  | { status: "interrupted" };

export class StreamingToolExecutor {
  private toolUses: Anthropic.ToolUseBlock[] = [];
  private earlyExecutions = new Map<string, Promise<ToolExecutionOutcome>>();
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

      if (this.context.signal?.aborted) {
        results.push(this.toToolResult(toolUse, { status: "interrupted" }));
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

  async settle(): Promise<void> {
    await Promise.all(this.earlyExecutions.values());
  }

  private isConcurrencySafe(block: Anthropic.ToolUseBlock): boolean {
    return isToolConcurrencySafe(
      block.name,
      block.input as Record<string, unknown>,
    );
  }

  private async executeBlock(block: Anthropic.ToolUseBlock): Promise<ToolExecutionOutcome> {
    if (this.context.signal?.aborted) {
      return { status: "interrupted" };
    }

    try {
      const output = await this.execute(
        block.name,
        block.input as Record<string, unknown>,
        this.context,
      );
      return { status: "completed", output };
    } catch (error) {
      if (this.context.signal?.aborted) {
        return { status: "interrupted" };
      }
      throw error;
    }
  }

  private logToolUse(block: Anthropic.ToolUseBlock): void {
    console.log(`  -> ${block.name}(${JSON.stringify(block.input)})`);
  }

  private toToolResult(
    block: Anthropic.ToolUseBlock,
    outcome: ToolExecutionOutcome,
  ): Anthropic.ToolResultBlockParam {
    if (outcome.status === "interrupted") {
      return {
        type: "tool_result",
        tool_use_id: block.id,
        content: "Interrupted by user.",
        is_error: true,
      };
    }

    const result: Anthropic.ToolResultBlockParam = {
      type: "tool_result",
      tool_use_id: block.id,
      content: outcome.output.content,
    };
    if (outcome.output.isError) result.is_error = true;
    return result;
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
  private cwd: string;
  private permissionGate: PermissionGate;
  private permissionModePolicy: PermissionModePolicy;
  private bypassPermissionsAvailable: boolean;
  private abortController: AbortController | undefined;
  private promptCacheUsage: PromptCacheUsage = {
    creationInputTokens: 0,
    readInputTokens: 0,
  };

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
    this.cwd = process.cwd();
    const permissionSettings = options.permissionSettings
      ?? loadPermissionSettings({ cwd: this.cwd });
    this.permissionModePolicy = new PermissionModePolicy(
      options.permissionMode ?? permissionSettings.defaultMode ?? "default",
    );
    this.permissionGate = new PermissionGate({
      policy: new PermissionRulePolicy(
        permissionSettings.rules,
        this.permissionModePolicy,
        toolDefinitions.map((tool) => tool.name),
      ),
      prompter: options.permissionPrompter,
    });
    // 危险模式必须由 CLI 参数或配置显式启用；CLI 可以覆盖本次启动的初始模式，
    // 但配置中启用过 bypassPermissions 时，仍允许用户在当前会话切换回来。
    this.bypassPermissionsAvailable =
      options.allowDangerouslySkipPermissions === true
      || this.permissionModePolicy.getMode() === "bypassPermissions"
      || permissionSettings.defaultMode === "bypassPermissions";
  }

  getMessages(): Message[] {
    return structuredClone(this.messages);
  }

  getModel(): string {
    return this.model;
  }

  isThinkingEnabled(): boolean {
    return this.thinkingEnabled;
  }

  getPromptCacheUsage(): PromptCacheUsage {
    return { ...this.promptCacheUsage };
  }

  setThinkingEnabled(enabled: boolean): void {
    this.thinkingEnabled = enabled;
  }

  getPermissionMode(): PermissionMode {
    return this.permissionModePolicy.getMode();
  }

  setPermissionMode(mode: PermissionMode): void {
    if (this.isProcessing()) {
      throw new Error("Agent 正在处理请求，不能切换权限模式");
    }
    /** 准备切换的权限模式是危险模式，且已开放权限模式 */
    if (mode === "bypassPermissions" && !this.bypassPermissionsAvailable) {
      throw new Error(
        "bypassPermissions 未启用，请使用 --allow-dangerously-skip-permissions 重新启动",
      );
    }
    this.permissionModePolicy.setMode(mode);
  }

  isBypassPermissionsAvailable(): boolean {
    return this.bypassPermissionsAvailable;
  }

  isProcessing(): boolean {
    return this.abortController !== undefined;
  }

  abort(): void {
    this.abortController?.abort();
  }

  restoreMessages(messages: Message[]): void {
    this.messages = structuredClone(messages);
  }

  private async callAnthropicStream(
    signal: AbortSignal,
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
    const stream = this.client.messages.stream(
      {
        model: this.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        cache_control: { type: "ephemeral" },
        thinking,
        system: this.systemPrompt,
        tools: toolDefinitions,
        messages: this.messages,
      },
      { signal },
    );

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

    const abortWriter = () => writer.abort();
    signal.addEventListener("abort", abortWriter, { once: true });

    let reply: Anthropic.Message;
    try {
      reply = await stream.finalMessage();
    } finally {
      if (signal.aborted) {
        writer.abort();
      } else {
        await writer.finish();
      }
      signal.removeEventListener("abort", abortWriter);
    }

    if (writer.hasText) process.stdout.write("\n");
    this.promptCacheUsage.creationInputTokens +=
      reply.usage.cache_creation_input_tokens ?? 0;
    this.promptCacheUsage.readInputTokens +=
      reply.usage.cache_read_input_tokens ?? 0;
    return reply;
  }

  async chat(userText: string): Promise<ChatResult> {
    if (this.abortController) {
      throw new Error("Agent 已在处理请求");
    }

    /** 初始化创建控制器 */
    const controller = new AbortController();
    const { signal } = controller;
    this.abortController = controller;

    try {
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
        if (signal.aborted) return "interrupted";

        const toolExecutor = new StreamingToolExecutor({
          cwd: this.cwd,
          permissionGate: this.permissionGate,
          readFileState: this.readFileState,
          signal,
        });
        let reply: Anthropic.Message;
        try {
          reply = await this.callAnthropicStream(signal, (block) => {
            toolExecutor.accept(block);
          });
        } catch (error) {
          if (!signal.aborted) throw error;
          await toolExecutor.settle();
          return "interrupted";
        }

        this.messages.push({ role: "assistant", content: reply.content });

        const results = await toolExecutor.finish();
        if (results.length > 0) {
          this.messages.push({ role: "user", content: results });
        }
        if (signal.aborted) return "interrupted";
        if (results.length === 0) return "completed";
      }
    } finally {
      if (this.abortController === controller) {
        this.abortController = undefined;
      }
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
