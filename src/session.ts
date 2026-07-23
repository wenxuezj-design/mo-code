import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  truncateSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Message } from "./agent-loop.ts";

export type SessionData = {
  version: 1;
  id: string;
  cwd: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
};

export type LatestSessionResult = {
  session?: SessionData;
  skippedFiles: string[];
};

export type SessionListResult = {
  sessions: SessionData[];
  skippedFiles: string[];
};

type SessionRecord = {
  type: "session";
  version: 1;
  id: string;
  cwd: string;
  model: string;
  createdAt: string;
};

type TurnRecord = {
  type: "turn";
  timestamp: string;
  model: string;
  messages: Message[];
};

const SESSION_DIR = join(homedir(), ".mo-code", "sessions");
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createSession(cwd: string, model: string): SessionData {
  const now = new Date().toISOString();

  return {
    version: 1,
    id: randomUUID(),
    cwd,
    model,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

export function appendSessionTurn(session: SessionData, messages: Message[]): void {
  const timestamp = new Date().toISOString();
  const turn: TurnRecord = {
    type: "turn",
    timestamp,
    model: session.model,
    messages,
  };
  const filePath = join(SESSION_DIR, `${session.id}.jsonl`);

  mkdirSync(SESSION_DIR, { recursive: true });
  const records: Array<SessionRecord | TurnRecord> = [];
  if (!existsSync(filePath)) {
    records.push({
      type: "session",
      version: session.version,
      id: session.id,
      cwd: session.cwd,
      model: session.model,
      createdAt: session.createdAt,
    });
  }
  records.push(turn);

  appendFileSync(
    filePath,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf-8",
  );
  session.updatedAt = timestamp;
}

export function loadSession(id: string): SessionData {
  if (!SESSION_ID_PATTERN.test(id)) {
    throw new Error(`无效的会话 ID: ${id}`);
  }

  const filePath = join(SESSION_DIR, `${id}.jsonl`);
  let contents: Buffer;
  try {
    contents = readFileSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`找不到会话: ${id}`);
    }
    throw error;
  }

  // 换行符是完整记录的提交标记。进程中断留下的末尾残缺行可以安全丢弃，
  // 同时截掉它，避免恢复会话后追加的新 turn 把残缺行变成文件中间损坏。
  if (contents.length > 0 && contents[contents.length - 1] !== 0x0a) {
    const lastNewline = contents.lastIndexOf(0x0a);
    if (lastNewline < 0) {
      throw new Error(`会话文件已损坏: ${id}`);
    }
    truncateSync(filePath, lastNewline + 1);
    contents = contents.subarray(0, lastNewline + 1);
  }

  let records: unknown[];
  try {
    const lines = contents.toString("utf-8").split("\n");
    lines.pop();
    records = lines.map((line) => JSON.parse(line) as unknown);
  } catch {
    throw new Error(`会话文件已损坏: ${id}`);
  }

  const [header, ...turns] = records;
  if (!isSessionRecord(header, id) || !turns.every(isTurnRecord)) {
    throw new Error(`会话文件已损坏: ${id}`);
  }

  const lastTurn = turns.at(-1);
  return {
    version: header.version,
    id: header.id,
    cwd: header.cwd,
    model: lastTurn?.model ?? header.model,
    createdAt: header.createdAt,
    updatedAt: lastTurn?.timestamp ?? header.createdAt,
    messages: turns.flatMap((turn) => turn.messages),
  };
}

export function deleteSession(id: string): void {
  if (!SESSION_ID_PATTERN.test(id)) {
    throw new Error(`无效的会话 ID: ${id}`);
  }

  try {
    unlinkSync(join(SESSION_DIR, `${id}.jsonl`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`找不到会话: ${id}`);
    }
    throw error;
  }
}

export function listSessions(cwd: string): SessionListResult {
  let filenames: string[];
  try {
    filenames = readdirSync(SESSION_DIR);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { sessions: [], skippedFiles: [] };
    }
    throw error;
  }

  const sessions: SessionData[] = [];
  const skippedFiles: string[] = [];

  for (const filename of filenames) {
    if (!filename.endsWith(".jsonl")) continue;

    const id = filename.slice(0, -".jsonl".length);
    if (!SESSION_ID_PATTERN.test(id)) continue;

    let session: SessionData;
    try {
      session = loadSession(id);
    } catch {
      skippedFiles.push(filename);
      continue;
    }

    if (session.cwd !== cwd) continue;
    sessions.push(session);
  }

  // updatedAt 由 Date.toISOString() 生成，同一格式的字符串可直接比较先后。
  // 倒序排序，时间新的会排在前面
  sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { sessions, skippedFiles };
}

export function findLatestSession(cwd: string): LatestSessionResult {
  const { sessions, skippedFiles } = listSessions(cwd);
  return { session: sessions[0], skippedFiles };
}

function isSessionRecord(value: unknown, expectedId: string): value is SessionRecord {
  if (!isRecord(value)) return false;

  return value.type === "session"
    && value.version === 1
    && value.id === expectedId
    && typeof value.cwd === "string"
    && typeof value.model === "string"
    && typeof value.createdAt === "string";
}

function isTurnRecord(value: unknown): value is TurnRecord {
  if (!isRecord(value)) return false;

  return value.type === "turn"
    && typeof value.timestamp === "string"
    && typeof value.model === "string"
    && Array.isArray(value.messages)
    && value.messages.every(isMessage);
}

function isMessage(value: unknown): value is Message {
  if (!isRecord(value)) return false;
  if (value.role !== "user" && value.role !== "assistant") return false;

  return typeof value.content === "string"
    || (Array.isArray(value.content) && value.content.every(isContentBlock));
}

function isContentBlock(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string") return false;

  if (value.type === "text") {
    return typeof value.text === "string";
  }
  if (value.type === "tool_use") {
    return typeof value.id === "string"
      && typeof value.name === "string"
      && isRecord(value.input);
  }
  if (value.type === "tool_result") {
    return typeof value.tool_use_id === "string"
      && typeof value.content === "string";
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
