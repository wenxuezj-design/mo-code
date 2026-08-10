import { createInterface, type Interface } from "node:readline";

import type { Agent, ChatResult } from "../agent/index.ts";
import type { PermissionMode } from "../permissions/index.ts";
import { appendSessionTurn, type SessionData } from "../session.ts";

const REPL_HELP_TEXT = `REPL 内置命令:
  /help             显示这份帮助
  /status           显示当前会话状态
  /permission-mode  选择权限模式
  /thinking         切换 Extended Thinking
  /exit, /quit      退出交互模式
`;

const PERMISSION_MODE_OPTIONS = [
  "default",
  "acceptEdits",
  "plan",
  "dontAsk",
  "bypassPermissions",
] as const satisfies readonly PermissionMode[];

const PERMISSION_MODE_PROMPT = "请选择权限模式 [1-5]，输入 q 取消: ";

function showPermissionModeMenu(agent: Agent): void {
  process.stdout.write("选择权限模式:\n");
  PERMISSION_MODE_OPTIONS.forEach((mode, index) => {
    const current = mode === agent.getPermissionMode() ? "（当前）" : "";
    const unavailable = mode === "bypassPermissions"
      && !agent.isBypassPermissionsAvailable()
      ? "（未开放）"
      : "";
    process.stdout.write(`${index + 1}. ${mode}${current}${unavailable}\n`);
  });
  process.stdout.write("q. 取消\n");
}

function saveAgentTurn(agent: Agent, session: SessionData): void {
  const messages = agent.getMessages();
  // session.messages 保存的是上一次成功完成 chat 时的快照，用它切出本轮新增消息。
  const turnMessages = messages.slice(session.messages.length);
  session.messages = messages;
  session.model = agent.getModel();

  try {
    appendSessionTurn(session, turnMessages);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Warning: 会话保存失败: ${message}\n`);
  }
}

export async function runTurn(
  agent: Agent,
  session: SessionData,
  input: string,
): Promise<ChatResult> {
  const result = await agent.chat(input);
  saveAgentTurn(agent, session);
  return result;
}

function reportInterrupted(): void {
  process.stderr.write("\n(interrupted)\n");
}

export async function runPrintTurn(
  agent: Agent,
  session: SessionData,
  input: string,
): Promise<void> {
  const handleSigint = () => agent.abort();
  process.on("SIGINT", handleSigint);
  try {
    const result = await runTurn(agent, session, input);
    if (result === "interrupted") {
      reportInterrupted();
      process.exitCode = 130;
    }
  } finally {
    process.off("SIGINT", handleSigint);
  }
}

export async function runRepl(
  agent: Agent,
  session: SessionData,
  initialPrompt?: string,
): Promise<void> {
  let rl: Interface | undefined;
  let sigintCount = 0;
  let exitRequested = false;
  let selectingPermissionMode = false;

  const handleSigint = () => {
    if (agent.isProcessing()) {
      agent.abort();
      sigintCount = 0;
      return;
    }

    sigintCount++;
    if (sigintCount >= 2) {
      exitRequested = true;
      process.stderr.write("\nBye!\n");
      rl?.close();
      return;
    }

    process.stderr.write("\nPress Ctrl+C again to exit.\n");
    rl?.prompt();
  };

  process.on("SIGINT", handleSigint);
  try {
    if (initialPrompt) {
      const result = await runTurn(agent, session, initialPrompt);
      if (result === "interrupted") reportInterrupted();
    }
    if (exitRequested) return;

    rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.setPrompt("> ");
    rl.prompt();

    for await (const line of rl) {
      sigintCount = 0;
      const input = line.trim();
      if (selectingPermissionMode) {
        if (input.toLowerCase() === "q") {
          selectingPermissionMode = false;
          process.stdout.write("已取消\n");
          rl.setPrompt("> ");
        } else if (/^[1-5]$/.test(input)) {
          const mode = PERMISSION_MODE_OPTIONS[Number(input) - 1];
          if (
            mode === "bypassPermissions"
            && !agent.isBypassPermissionsAvailable()
          ) {
            process.stdout.write(
              "bypassPermissions 未开放，请使用 "
              + "--allow-dangerously-skip-permissions 重新启动\n",
            );
            rl.setPrompt(PERMISSION_MODE_PROMPT);
          } else {
            agent.setPermissionMode(mode);
            selectingPermissionMode = false;
            process.stdout.write(`权限模式: ${mode}\n`);
            rl.setPrompt("> ");
          }
        } else {
          process.stdout.write("请输入 1 到 5 之间的编号，或输入 q 取消\n");
          rl.setPrompt(PERMISSION_MODE_PROMPT);
        }

        if (!exitRequested) rl.prompt();
        continue;
      }

      if (input === "/exit" || input === "/quit") break;
      if (input === "/help") {
        process.stdout.write(REPL_HELP_TEXT);
      } else if (input === "/status") {
        const cacheUsage = agent.getPromptCacheUsage();
        process.stdout.write(
          `会话 ID: ${session.id}\n`
          + `工作目录: ${session.cwd}\n`
          + `模型: ${agent.getModel()}\n`
          + `权限模式: ${agent.getPermissionMode()}\n`
          + `Thinking: ${agent.isThinkingEnabled() ? "开启" : "关闭"}\n`
          + `Prompt Cache 写入: ${cacheUsage.creationInputTokens} tokens\n`
          + `Prompt Cache 读取: ${cacheUsage.readInputTokens} tokens\n`,
        );
      } else if (input === "/thinking") {
        const enabled = !agent.isThinkingEnabled();
        agent.setThinkingEnabled(enabled);
        process.stdout.write(`Thinking: ${enabled ? "开启" : "关闭"}\n`);
      } else if (input === "/permission-mode") {
        selectingPermissionMode = true;
        showPermissionModeMenu(agent);
        rl.setPrompt(PERMISSION_MODE_PROMPT);
      } else if (input) {
        const result = await runTurn(agent, session, input);
        if (result === "interrupted") reportInterrupted();
      }
      if (!exitRequested) rl.prompt();
    }
  } finally {
    process.off("SIGINT", handleSigint);
    rl?.close();
  }
}
