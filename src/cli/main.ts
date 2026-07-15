import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { Agent } from "../agent-loop.ts";
import { HELP_TEXT, parseArgs, type ParsedArgs } from "./args.ts";
import { runRepl, runTurn } from "./conversation.ts";
import {
  confirmSessionDeletion,
  reportSkippedSessionFiles,
  selectSession,
  selectSessionToDelete,
} from "./session-ui.ts";
import {
  createSession,
  deleteSession,
  findLatestSession,
  listSessions,
  loadSession,
  type SessionData,
} from "../session.ts";

export { HELP_TEXT, parseArgs } from "./args.ts";

function getVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf-8"),
  ) as { version?: unknown };

  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("package.json 中缺少有效的 version");
  }

  return packageJson.version;
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
    if (parsed.prompt) await runTurn(agent, session, parsed.prompt);
    return;
  }

  await runRepl(agent, session, parsed.prompt);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
