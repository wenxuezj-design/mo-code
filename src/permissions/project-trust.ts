import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type ProjectTrustRoot = {
  kind: "git" | "directory";
  path: string;
  /** Home 只能获得当前进程中的会话项目信任，不能持久化。 */
  sessionOnly: boolean;
};

export type ProjectTrustStatus = {
  trusted: boolean;
  source: "persistent" | "session" | "none";
  sessionOnly: boolean;
};

type ResolveProjectTrustRootOptions = {
  cwd: string;
  homeDir?: string;
};

type ProjectTrustStoreOptions = {
  homeDir?: string;
  trustFilePath?: string;
};

type StoredProjectTrust = {
  acceptedRoots: string[];
};

/**
 * 解析本次启动绑定的信任根。
 * Git 项目使用距离 cwd 最近的仓库根，非 Git 项目直接使用启动 cwd。
 */
export function resolveProjectTrustRoot(
  options: ResolveProjectTrustRootOptions,
): ProjectTrustRoot {
  const cwd = canonicalizeDirectory(options.cwd, "working directory");
  const homeDirectory = normalizeHomeDirectory(options.homeDir ?? homedir());
  const gitRoot = findNearestGitRoot(cwd);
  const path = gitRoot ?? cwd;

  return {
    kind: gitRoot ? "git" : "directory",
    path,
    sessionOnly: path === homeDirectory,
  };
}

/**
 * 用户侧的项目信任记录。
 *
 * 读取失败或内容损坏时不采用任何持久信任。accept() 只有在文件成功写入后
 * 才会更新内存状态，因此持久化失败不会意外放行项目配置。
 */
export class ProjectTrustStore {
  private readonly homeDirectory: string;
  private readonly trustFilePath: string;
  private readonly persistentRoots: Set<string>;
  private readonly sessionRoots = new Set<string>();

  constructor(options: ProjectTrustStoreOptions = {}) {
    this.homeDirectory = normalizeHomeDirectory(options.homeDir ?? homedir());
    this.trustFilePath = resolve(
      options.trustFilePath
        ?? join(this.homeDirectory, ".mo-code", "trust.json"),
    );
    this.persistentRoots = loadPersistentRoots(
      this.trustFilePath,
      this.homeDirectory,
    );
  }

  getStatus(root: ProjectTrustRoot): ProjectTrustStatus {
    const normalizedRoot = normalizeTrustRoot(root.path);
    const sessionOnly = normalizedRoot === this.homeDirectory;

    if (this.sessionRoots.has(normalizedRoot)) {
      return { trusted: true, source: "session", sessionOnly };
    }
    if (!sessionOnly && this.persistentRoots.has(normalizedRoot)) {
      return { trusted: true, source: "persistent", sessionOnly: false };
    }
    return { trusted: false, source: "none", sessionOnly };
  }

  isTrusted(root: ProjectTrustRoot): boolean {
    return this.getStatus(root).trusted;
  }

  /**
   * 接受一个信任根。Home 仅写入当前 store 的会话状态，其他目录必须先成功
   * 写入用户侧 trust.json，之后才会被视为 trusted。
   */
  accept(root: ProjectTrustRoot): ProjectTrustStatus {
    const normalizedRoot = normalizeTrustRoot(root.path);
    if (normalizedRoot === this.homeDirectory) {
      this.sessionRoots.add(normalizedRoot);
      return { trusted: true, source: "session", sessionOnly: true };
    }

    if (this.persistentRoots.has(normalizedRoot)) {
      return { trusted: true, source: "persistent", sessionOnly: false };
    }

    const acceptedRoots = [...this.persistentRoots, normalizedRoot].sort();
    persistRoots(this.trustFilePath, acceptedRoots);
    // 必须晚于 persistRoots：写入失败时不能先在当前进程中放行。
    this.persistentRoots.add(normalizedRoot);
    return { trusted: true, source: "persistent", sessionOnly: false };
  }
}

function findNearestGitRoot(cwd: string): string | undefined {
  let current = cwd;
  while (true) {
    // worktree 和 submodule 的 .git 可以是文件，existsSync 同时覆盖两种形式。
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function loadPersistentRoots(path: string, homeDirectory: string): Set<string> {
  if (!existsSync(path)) return new Set();

  try {
    const value = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!isStoredProjectTrust(value)) return new Set();

    const roots = new Set<string>();
    for (const root of value.acceptedRoots) {
      // Home 的持久条目即使被手工写入也不生效。
      if (root !== homeDirectory) roots.add(root);
    }
    return roots;
  } catch {
    // 信任状态不可确定时按未信任处理。
    return new Set();
  }
}

function isStoredProjectTrust(value: unknown): value is StoredProjectTrust {
  if (!isRecord(value) || !Array.isArray(value.acceptedRoots)) return false;
  return value.acceptedRoots.every((root) => (
    typeof root === "string"
    && isAbsolute(root)
    && resolve(root) === root
  ));
}

function persistRoots(path: string, acceptedRoots: string[]): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const contents: StoredProjectTrust = { acceptedRoots };
    writeFileSync(path, `${JSON.stringify(contents, null, 2)}\n`, "utf-8");
  } catch (error) {
    throw new Error(
      `Cannot persist project trust at ${path}: ${getErrorMessage(error)}`,
      { cause: error },
    );
  }
}

function normalizeTrustRoot(path: string): string {
  return canonicalizeDirectory(path, "project trust root");
}

function normalizeHomeDirectory(path: string): string {
  const resolved = resolve(path);
  try {
    const canonical = realpathSync(resolved);
    return statSync(canonical).isDirectory() ? canonical : resolved;
  } catch {
    // Home 不可用时仍允许受限运行；读取和持久化信任都会自然失败关闭。
    return resolved;
  }
}

function canonicalizeDirectory(path: string, label: string): string {
  const resolved = resolve(path);
  try {
    const canonical = realpathSync(resolved);
    if (!statSync(canonical).isDirectory()) {
      throw new Error("path is not a directory");
    }
    return canonical;
  } catch (error) {
    throw new Error(
      `Cannot resolve ${label} ${resolved}: ${getErrorMessage(error)}`,
      { cause: error },
    );
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
