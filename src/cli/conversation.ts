import { createInterface } from "node:readline";

import type { Agent } from "../agent-loop.ts";
import { appendSessionTurn, type SessionData } from "../session.ts";

const REPL_HELP_TEXT = `REPL 内置命令:
  /help          显示这份帮助
  /status        显示当前会话状态
  /exit, /quit   退出交互模式
`;

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
): Promise<void> {
  await agent.chat(input);
  saveAgentTurn(agent, session);
}

export async function runRepl(
  agent: Agent,
  session: SessionData,
  initialPrompt?: string,
): Promise<void> {
  if (initialPrompt) await runTurn(agent, session, initialPrompt);

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
      await runTurn(agent, session, input);
    }
    rl.prompt();
  }

  rl.close();
}
