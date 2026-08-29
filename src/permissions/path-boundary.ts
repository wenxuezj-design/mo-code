import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import {
  dirname,
  isAbsolute,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";

import type {
  FilesystemAccess,
  FilesystemAccessPlan,
} from "./types.ts";

const PROTECTED_DIRECTORY_NAMES = new Set([".git", ".mo-code", ".claude"]);
const PROTECTED_FILE_NAMES = new Set([
  ".gitmodules",
  "claude.md",
  "agents.md",
]);

export type ResolvedFilesystemAccess = FilesystemAccess & {
  /** 以本次工具 cwd 为基准得到的词法路径。 */
  requestedPath: string;
  /** 跟随符号链接后的目标；无法可靠解析时不存在。 */
  resolvedPath?: string;
  outsideWorkingDirectory: boolean;
  protectedPath: boolean;
  catastrophicDelete: boolean;
};

export type PathBoundaryAssessment =
  | { status: "notApplicable" }
  | {
    status: "unknown";
    accesses?: ResolvedFilesystemAccess[];
    hasCatastrophicDelete?: boolean;
  }
  | {
    status: "known";
    accesses: ResolvedFilesystemAccess[];
    hasUnresolvedPath: boolean;
    hasExternalPath: boolean;
    hasProtectedPath: boolean;
    hasCatastrophicDelete: boolean;
  };

type PathBoundaryOptions = {
  /** 允许测试或宿主显式定义需要保护的 Home 根目录。 */
  homeDirectory?: string;
};

/**
 * 只解析文件系统边界事实；allow/ask/deny 由权限策略统一决定。
 */
export class PathBoundary {
  private readonly homeDirectory: string;

  constructor(options: PathBoundaryOptions = {}) {
    this.homeDirectory = resolve(options.homeDirectory ?? homedir());
  }

  inspect(
    cwd: string,
    plan: FilesystemAccessPlan | undefined,
  ): PathBoundaryAssessment {
    if (!plan) return { status: "notApplicable" };
    if (plan.status === "unknown" && !plan.accesses?.length) {
      return {
        status: "unknown",
        ...(plan.catastrophicDeleteRisk
          ? { hasCatastrophicDelete: true }
          : {}),
      };
    }

    const lexicalCwd = resolve(cwd);
    const realCwd = resolveRealTarget(lexicalCwd);
    // cwd 自身可能是符号链接。两种表示都属于同一个主工作目录。
    const workingRoots = uniquePaths([lexicalCwd, realCwd]);
    const homeRoots = uniquePaths([
      this.homeDirectory,
      resolveRealTarget(this.homeDirectory),
    ]);

    const accesses = (plan.accesses ?? []).map((access) => {
      const rawTarget = isAbsolute(access.path)
        ? access.path
        : `${lexicalCwd}${sep}${access.path}`;
      const requestedPath = resolve(rawTarget);
      // realpath 必须看到尚未词法折叠的 `link/..`，才能遵循文件系统实际的
      // “先跟随链接、再返回上级目录”语义。
      const resolvedPath = resolveRealTarget(rawTarget);
      const checkedPaths = uniquePaths([requestedPath, resolvedPath]);
      const outsideWorkingDirectory = checkedPaths.some((path) =>
        !isInsideAny(path, workingRoots)
      );
      const protectedPath = access.operation !== "read"
        && checkedPaths.some(isProtectedPath);
      const catastrophicDelete = access.operation === "delete"
        && access.recursive === true
        && checkedPaths.some((path) =>
          isFilesystemRoot(path)
          || homeRoots.some((homePath) =>
            homePath.toLowerCase() === path.toLowerCase()
          )
        );

      return {
        ...access,
        requestedPath,
        ...(resolvedPath === undefined ? {} : { resolvedPath }),
        outsideWorkingDirectory,
        protectedPath,
        catastrophicDelete,
      };
    });

    if (plan.status === "unknown") {
      return {
        status: "unknown",
        accesses,
        hasCatastrophicDelete: plan.catastrophicDeleteRisk === true
          || accesses.some((access) => access.catastrophicDelete),
      };
    }

    return {
      status: "known",
      accesses,
      hasUnresolvedPath: accesses.some((access) =>
        access.resolvedPath === undefined
      ),
      hasExternalPath: accesses.some((access) =>
        access.outsideWorkingDirectory
      ),
      hasProtectedPath: accesses.some((access) => access.protectedPath),
      hasCatastrophicDelete: accesses.some((access) =>
        access.catastrophicDelete
      ),
    };
  }
}

/**
 * 新目标本身不存在时，从最近的已存在祖先解析符号链接，再拼回剩余路径。
 */
function resolveRealTarget(target: string): string | undefined {
  const root = parse(target).root;
  if (root.length === 0) return undefined;

  let current = root;
  let encounteredMissingSegment = false;
  for (const segment of target.slice(root.length).split(sep)) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      // 文件系统不会穿过一个尚不存在的目录再返回上级。
      if (encounteredMissingSegment) return undefined;
      current = dirname(current);
      continue;
    }

    const candidate = resolve(current, segment);
    if (encounteredMissingSegment) {
      current = candidate;
      continue;
    }

    try {
      current = realpathSync(candidate);
    } catch {
      // realpath 失败但 lstat 成功，通常表示悬空链接或链接环；不能把它
      // 当成普通的新文件目标。只有真正不存在的段才进入“最近祖先”逻辑。
      try {
        lstatSync(candidate);
        return undefined;
      } catch (lstatError) {
        if (!hasErrorCode(lstatError, "ENOENT")) return undefined;
        encounteredMissingSegment = true;
        current = candidate;
      }
    }
  }
  return resolve(current);
}

function isInsideAny(target: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    const pathFromRoot = relative(root, target);
    return pathFromRoot === ""
      || (
        pathFromRoot !== ".."
        && !pathFromRoot.startsWith(`..${sep}`)
        && !isAbsolute(pathFromRoot)
      );
  });
}

function isProtectedPath(target: string): boolean {
  const root = parse(target).root;
  const components = relative(root, target).split(sep).filter(Boolean);
  return components.some((component) =>
    PROTECTED_DIRECTORY_NAMES.has(component.toLowerCase())
    || PROTECTED_FILE_NAMES.has(component.toLowerCase())
  );
}

function isFilesystemRoot(target: string): boolean {
  return resolve(target) === parse(resolve(target)).root;
}

function uniquePaths(paths: Array<string | undefined>): string[] {
  return [...new Set(paths.filter((path): path is string => path !== undefined))];
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === code;
}
