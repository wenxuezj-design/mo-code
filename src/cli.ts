import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import { Agent } from "./agent-loop.ts";
import {
  appendSessionTurn,
  createSession,
  deleteSession,
  findLatestSession,
  listSessions,
  loadSession,
  type SessionData,
} from "./session.ts";

export const HELP_TEXT = `Usage: mo-code [options] [prompt...]

Options:
  -h, --help                         显示帮助信息
  -v, --version                      显示当前版本
  -p, --print                        执行非交互任务后退出
  -c, --continue                     继续当前项目最近的会话
  -r, --resume [id]                  恢复指定会话；未提供 ID 时从列表选择
      --delete-session [id]          删除会话；未提供 ID 时从列表选择
  -m, --model <model>                设置本次会话使用的模型
      --permission-mode <mode>       设置权限模式
      --dangerously-skip-permissions 跳过权限检查，仅用于隔离环境
      --mortis                       --dangerously-skip-permissions 的别名
      --effort <level>               设置模型的推理强度
      --max-budget-usd <amount>      限制本次运行的最大费用
`;

const REPL_HELP_TEXT = `REPL 内置命令:
  /help          显示这份帮助
  /status        显示当前会话状态
  /exit, /quit   退出交互模式
`;

type ParsedArgs = {
  help: boolean;
  version: boolean;
  print: boolean;
  continueSession: boolean;
  resume: boolean;
  deleteSession: boolean;
  model?: string;
  permissionMode?: string;
  resumeId?: string;
  deleteSessionId?: string;
  prompt?: string;
};

export function parseArgs(args: string[]): ParsedArgs {
  let help = false;
  let version = false;
  let print = false;
  let continueSession = false;
  let resume = false;
  let deleteSessionRequested = false;
  let model: string | undefined;
  let permissionMode: string | undefined;
  let resumeId: string | undefined;
  let deleteSessionId: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--version" || arg === "-v") {
      version = true;
    } else if (arg === "--print" || arg === "-p") {
      print = true;
    } else if (arg === "--continue" || arg === "-c") {
      continueSession = true;
    } else if (arg === "--model" || arg === "-m") {
      model = args[++i];
    } else if (arg === "--permission-mode") {
      permissionMode = args[++i];
    } else if (arg === "--resume" || arg === "-r") {
      resume = true;
      const sessionId = args[i + 1];
      if (sessionId && !sessionId.startsWith("-")) {
        resumeId = sessionId;
        i++;
      }
    } else if (arg === "--delete-session") {
      deleteSessionRequested = true;
      const sessionId = args[i + 1];
      if (sessionId && !sessionId.startsWith("-")) {
        deleteSessionId = sessionId;
        i++;
      }
    } else {
      positional.push(arg);
    }
  }

  if (continueSession && resume) {
    throw new Error("--continue 和 --resume 不能同时使用");
  }
  if (deleteSessionRequested && (continueSession || resume)) {
    throw new Error("--delete-session 不能和 --continue 或 --resume 同时使用");
  }

  return {
    help,
    version,
    print,
    continueSession,
    resume,
    deleteSession: deleteSessionRequested,
    model,
    permissionMode,
    resumeId,
    deleteSessionId,
    prompt: positional.length > 0 ? positional.join(" ") : undefined,
  };
}

function getVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
  ) as { version?: unknown };

  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("package.json 中缺少有效的 version");
  }

  return packageJson.version;
}

function getSessionPreview(session: SessionData): string {
  const firstUserMessage = session.messages.find((message) => message.role === "user");
  if (!firstUserMessage) return "(无消息)";

  let text: string;
  if (typeof firstUserMessage.content === "string") {
    text = firstUserMessage.content;
  } else {
    // 第一条用户消息可能先放项目上下文，最后一个 text block 才是用户输入。
    const lastTextBlock = [...firstUserMessage.content]
      .reverse()
      .find((block) => block.type === "text");
    text = lastTextBlock?.type === "text" ? lastTextBlock.text : "";
  }

  const preview = text.replace(/\s+/g, " ").trim();
  if (!preview) return "(无文本)";
  return preview.length > 60 ? `${preview.slice(0, 57)}...` : preview;
}

function printSessionList(title: string, sessions: SessionData[]): void {
  process.stdout.write(`${title}\n\n`);
  sessions.forEach((session, index) => {
    process.stdout.write(
      `${index + 1}. ${session.updatedAt} | ${session.model} | ${getSessionPreview(session)}\n`,
    );
  });
}

async function selectSession(sessions: SessionData[]): Promise<SessionData | undefined> {
  printSessionList("可恢复的会话:", sessions);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const prompt = `请选择会话 [1-${sessions.length}]，输入 q 取消: `;
  rl.setPrompt(prompt);
  rl.prompt();

  try {
    for await (const line of rl) {
      const input = line.trim();
      if (input.toLowerCase() === "q") {
        process.stdout.write("已取消\n");
        return undefined;
      }

      if (/^[1-9]\d*$/.test(input)) {
        const selected = sessions[Number(input) - 1];
        if (selected) return selected;
      }

      process.stdout.write(
        `请输入 1 到 ${sessions.length} 之间的编号，或输入 q 取消\n`,
      );
      rl.prompt();
    }
    return undefined;
  } finally {
    rl.close();
  }
}

function isConfirmed(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
}

async function confirmSessionDeletion(id: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt(`确定删除会话 ${id}？输入 y/yes 确认，其他输入取消: `);
  rl.prompt();

  try {
    for await (const line of rl) {
      if (isConfirmed(line)) return true;
      process.stdout.write("已取消\n");
      return false;
    }
    process.stdout.write("已取消\n");
    return false;
  } finally {
    rl.close();
  }
}

async function selectSessionToDelete(
  sessions: SessionData[],
): Promise<SessionData | undefined> {
  printSessionList("可删除的会话:", sessions);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const selectionPrompt = `请选择要删除的会话 [1-${sessions.length}]，输入 q 取消: `;
  let selected: SessionData | undefined;
  rl.setPrompt(selectionPrompt);
  rl.prompt();

  try {
    for await (const line of rl) {
      if (selected) {
        if (isConfirmed(line)) return selected;
        process.stdout.write("已取消\n");
        return undefined;
      }

      const input = line.trim();
      if (input.toLowerCase() === "q") {
        process.stdout.write("已取消\n");
        return undefined;
      }

      if (/^[1-9]\d*$/.test(input)) {
        selected = sessions[Number(input) - 1];
        if (selected) {
          rl.setPrompt(
            `确定删除会话 ${selected.id}？输入 y/yes 确认，其他输入取消: `,
          );
          rl.prompt();
          continue;
        }
      }

      process.stdout.write(
        `请输入 1 到 ${sessions.length} 之间的编号，或输入 q 取消\n`,
      );
      rl.setPrompt(selectionPrompt);
      rl.prompt();
    }
    return undefined;
  } finally {
    rl.close();
  }
}

function reportSkippedSessionFiles(filenames: string[]): void {
  for (const filename of filenames) {
    process.stderr.write(`Warning: 跳过损坏的会话文件: ${filename}\n`);
  }
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

async function chatAndSave(agent: Agent, session: SessionData, input: string): Promise<void> {
  await agent.chat(input);
  saveAgentTurn(agent, session);
}

async function runRepl(
  agent: Agent,
  session: SessionData,
  initialPrompt?: string,
): Promise<void> {
  if (initialPrompt) await chatAndSave(agent, session, initialPrompt);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt("> ");
  rl.prompt();

  for await (const line of rl) {
    const input = line.trim();
    if (input === "/exit" || input === "/quit") break;
    if (input === "/help") {
      process.stdout.write(REPL_HELP_TEXT);
    } else if (input === "/status") {
      process.stdout.write(
        `会话 ID: ${session.id}\n`
        + `工作目录: ${session.cwd}\n`
        + `模型: ${agent.getModel()}\n`,
      );
    } else if (input) {
      await chatAndSave(agent, session, input);
    }
    rl.prompt();
  }

  rl.close();
}

function reportCliError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
}

export async function runCli(args = process.argv.slice(2)): Promise<void> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    reportCliError(error);
    return;
  }

  if (parsed.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  if (parsed.version) {
    process.stdout.write(`${getVersion()} (mo-code)\n`);
    return;
  }

  if (parsed.permissionMode) {
    process.stderr.write("Warning: --permission-mode 暂未实现权限控制\n");
  }

  if (parsed.deleteSession) {
    try {
      let sessionId: string;
      if (parsed.deleteSessionId !== undefined) {
        sessionId = parsed.deleteSessionId;
        if (!await confirmSessionDeletion(sessionId)) return;
      } else {
        const result = listSessions(process.cwd());
        reportSkippedSessionFiles(result.skippedFiles);
        if (result.sessions.length === 0) {
          throw new Error("当前目录没有可删除的会话");
        }
        const selectedSession = await selectSessionToDelete(result.sessions);
        if (!selectedSession) return;
        sessionId = selectedSession.id;
      }

      deleteSession(sessionId);
      process.stdout.write(`已删除会话: ${sessionId}\n`);
    } catch (error) {
      reportCliError(error);
    }
    return;
  }

  let agent: Agent;
  let session: SessionData;

  if (parsed.resume || parsed.continueSession) {
    try {
      if (parsed.resumeId !== undefined) {
        session = loadSession(parsed.resumeId);
      } else if (parsed.resume) {
        const result = listSessions(process.cwd());
        reportSkippedSessionFiles(result.skippedFiles);
        if (result.sessions.length === 0) {
          throw new Error("当前目录没有可恢复的会话");
        }
        const selectedSession = await selectSession(result.sessions);
        if (!selectedSession) return;
        session = selectedSession;
      } else {
        const result = findLatestSession(process.cwd());
        reportSkippedSessionFiles(result.skippedFiles);
        if (!result.session) {
          throw new Error("当前目录没有可恢复的会话");
        }
        session = result.session;
      }
    } catch (error) {
      reportCliError(error);
      return;
    }

    // 当前版本要求回到原工作目录，避免旧会话上下文操作到其他项目。
    // Claude Code 对同仓库 worktree 有更灵活的处理，后续再扩展。
    if (session.cwd !== process.cwd()) {
      process.stderr.write(
        `Error: 会话 ${session.id} 属于另一个工作目录\n`
        + `  会话目录: ${session.cwd}\n`
        + `  当前目录: ${process.cwd()}\n`
        + `请切换到会话目录后重新运行 mo-code --resume ${session.id}\n`,
      );
      process.exitCode = 1;
      return;
    }

    agent = new Agent({ model: parsed.model ?? session.model });
    agent.restoreMessages(session.messages);
    session.model = agent.getModel();
  } else {
    agent = new Agent({ model: parsed.model });
    session = createSession(process.cwd(), agent.getModel());
  }

  if (parsed.print) {
    if (parsed.prompt) await chatAndSave(agent, session, parsed.prompt);
    return;
  }

  await runRepl(agent, session, parsed.prompt);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
