import { createInterface } from "node:readline";

import type { SessionData } from "../session.ts";

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

export async function selectSession(
  sessions: SessionData[],
): Promise<SessionData | undefined> {
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

export async function confirmSessionDeletion(id: string): Promise<boolean> {
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

export async function selectSessionToDelete(
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

export function reportSkippedSessionFiles(filenames: string[]): void {
  for (const filename of filenames) {
    process.stderr.write(`Warning: 跳过损坏的会话文件: ${filename}\n`);
  }
}
