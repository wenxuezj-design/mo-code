import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
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

const SESSION_DIR = join(homedir(), ".mo-code", "sessions");

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
