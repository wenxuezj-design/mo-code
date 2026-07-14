import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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

export function saveSession(session: SessionData): void {
  session.updatedAt = new Date().toISOString();
  mkdirSync(SESSION_DIR, { recursive: true });
  writeFileSync(
    join(SESSION_DIR, `${session.id}.json`),
    `${JSON.stringify(session, null, 2)}\n`,
    "utf-8",
  );
}

export function loadSession(id: string): SessionData {
  if (!SESSION_ID_PATTERN.test(id)) {
    throw new Error(`无效的会话 ID: ${id}`);
  }

  let json: string;
  try {
    json = readFileSync(join(SESSION_DIR, `${id}.json`), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`找不到会话: ${id}`);
    }
    throw error;
  }

  try {
    return JSON.parse(json) as SessionData;
  } catch {
    throw new Error(`会话文件已损坏: ${id}`);
  }
}

export function findLatestSession(cwd: string): LatestSessionResult {
  let filenames: string[];
  try {
    filenames = readdirSync(SESSION_DIR);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { session: undefined, skippedFiles: [] };
    }
    throw error;
  }

  let latestSession: SessionData | undefined;
  const skippedFiles: string[] = [];

  for (const filename of filenames) {
    if (!filename.endsWith(".json")) continue;

    const id = filename.slice(0, -".json".length);
    if (!SESSION_ID_PATTERN.test(id)) continue;

    let session: SessionData;
    try {
      session = loadSession(id);
    } catch {
      skippedFiles.push(filename);
      continue;
    }

    if (session.cwd !== cwd) continue;
    if (typeof session.updatedAt !== "string") {
      skippedFiles.push(filename);
      continue;
    }

    // updatedAt 由 Date.toISOString() 生成，同一格式的字符串可直接比较先后。
    if (!latestSession || session.updatedAt > latestSession.updatedAt) {
      latestSession = session;
    }
  }

  return { session: latestSession, skippedFiles };
}
