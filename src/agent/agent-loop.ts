import Anthropic from "@anthropic-ai/sdk";
import { realpathSync } from "node:fs";

import {
  addLocalPermissionAllowRule,
  PermissionGate,
  PermissionModePolicy,
  PermissionRulePolicy,
  ProjectTrustStore,
  loadPermissionSettings,
  resolveProjectTrustRoot,
  validatePermissionRules,
  type LoadedPermissionSettings,
  type PermissionMode,
  type PermissionPrompter,
} from "../permissions/index.ts";
import {
  SYSTEM_PROMPT_TEMPLATE,
  buildSystemPrompt,
  buildUserContextReminder,
  type SystemPromptBlock,
} from "../system-prompt.ts";
import { toolDefinitions } from "../tools/index.ts";
import { SmoothTextWriter } from "./smooth-text-writer.ts";
import { StreamingToolExecutor } from "./streaming-tool-executor.ts";

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
  permissionSessionGrants?: readonly string[];
};

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
  private permissionSessionGrants: Set<string>;
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
      ?? loadTrustedPermissionSettings(this.cwd);
    const knownToolNames = toolDefinitions.map((tool) => tool.name);
    validatePermissionRules([
      ...permissionSettings.rules,
      ...(permissionSettings.trustGated?.rules ?? []),
    ], knownToolNames);
    this.permissionModePolicy = new PermissionModePolicy(
      options.permissionMode ?? permissionSettings.defaultMode ?? "default",
    );
    this.permissionSessionGrants = new Set(options.permissionSessionGrants);
    this.permissionGate = new PermissionGate({
      policy: new PermissionRulePolicy(
        permissionSettings.rules,
        this.permissionModePolicy,
        knownToolNames,
      ),
      prompter: options.permissionPrompter,
      sessionGrants: this.permissionSessionGrants,
      persistGrant: (rule) => addLocalPermissionAllowRule({
        cwd: this.cwd,
        rule,
      }),
      onWarning: (message) => {
        process.stderr.write(`Warning: ${message}\n`);
      },
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

  getPermissionSessionGrants(): string[] {
    return [...this.permissionSessionGrants];
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
          reply = await this.permissionGate.deferPromptsWhile(
            () => this.callAnthropicStream(signal, (block) => {
              toolExecutor.accept(block);
            }),
          );
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

function loadTrustedPermissionSettings(cwd: string): LoadedPermissionSettings {
  const trustRoot = resolveProjectTrustRoot({ cwd });
  const projectTrusted = new ProjectTrustStore().isTrusted(trustRoot);
  const settings = loadPermissionSettings({
    cwd: realpathSync(cwd),
    trustRoot: trustRoot.path,
    projectTrusted,
  });
  validatePermissionRules([
    ...settings.rules,
    ...(settings.trustGated?.rules ?? []),
  ], toolDefinitions.map((tool) => tool.name));
  if (!projectTrusted && settings.trustGated) {
    const ignoredCount = settings.trustGated.rules.length
      + (settings.trustGated.defaultMode === undefined ? 0 : 1);
    process.stderr.write(
      `Warning: 当前项目尚未信任，已忽略 ${ignoredCount} 项权限扩张配置\n`,
    );
  }
  return settings;
}
