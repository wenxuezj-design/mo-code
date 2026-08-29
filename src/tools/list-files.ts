import { resolve } from "node:path";

import { glob } from "glob";

import {
  normalizePermissionPath,
  resolveToolPath,
} from "./permission-target.ts";
import type { Tool } from "./types.ts";

export const listFilesTool: Tool = {
  name: "list_files",
  getPermissionDescriptor(input, context) {
    const rootPath = resolveToolPath(
      context.cwd,
      String(input.path ?? "."),
    );
    const pattern = String(input.pattern ?? "");
    const accessRoot = resolveGlobAccessRoot(rootPath, pattern);
    return {
      permissionKind: "read",
      permissionTarget: normalizePermissionPath(
        rootPath,
        pattern,
      ),
      filesystemAccesses: accessRoot === undefined
        ? { status: "unknown" }
        : {
          status: "known",
          accesses: [{ path: accessRoot, operation: "read" }],
        },
    };
  },
  description: "List files matching a glob pattern. Returns matching file paths.",
  input_schema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: 'Glob pattern to match files (e.g., "**/*.ts", "src/**/*")',
      },
      path: {
        type: "string",
        description: "Base directory to search from. Defaults to current directory.",
      },
    },
    required: ["pattern"],
  },
  isConcurrencySafe: () => true,
  execute(input, context) {
    return listFiles({
      pattern: String(input.pattern ?? ""),
      path: resolveToolPath(context.cwd, String(input.path ?? ".")),
    });
  },
};

export async function listFiles(input: { pattern: string; path: string }): Promise<string> {
  try {
    const files = await glob(input.pattern, {
      cwd: input.path,
      nodir: true,
      ignore: ["node_modules/**", ".git/**"],
    });

    if (files.length === 0) {
      return "No files found matching the pattern.";
    }

    return files.slice(0, 200).join("\n");
  } catch (error) {
    return `Error listing files: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** 返回 glob 开始动态匹配前的静态搜索根；复杂的跨目录表达式无法可靠定位。 */
function resolveGlobAccessRoot(rootPath: string, pattern: string): string | undefined {
  const magicIndex = findFirstGlobMagic(pattern);
  if (magicIndex === -1) return resolve(rootPath, pattern);

  const lastSeparatorIndex = Math.max(
    pattern.lastIndexOf("/"),
    pattern.lastIndexOf("\\"),
  );
  // 动态目录既可能拼出 `..`，也可能命中指向工作目录外的符号链接。
  // 只有文件名部分包含 glob 时，静态目录才足以描述实际访问边界。
  if (magicIndex < lastSeparatorIndex) return undefined;

  const dynamicPart = pattern.slice(magicIndex);
  if (mayTraverseFromDynamicPattern(dynamicPart)) return undefined;

  const staticPrefix = pattern.slice(0, magicIndex);
  const separatorIndex = Math.max(
    staticPrefix.lastIndexOf("/"),
    staticPrefix.lastIndexOf("\\"),
  );
  const staticDirectory = separatorIndex === -1
    ? "."
    : staticPrefix.slice(0, separatorIndex + 1);
  // glob 会先按词法路径处理 pattern 中的 `..`，这里使用相同语义，确保
  // 权限检查的目标与实际搜索根一致。
  return resolve(rootPath, staticDirectory);
}

function findFirstGlobMagic(pattern: string): number {
  let escaped = false;
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "*" || character === "?" || character === "[" || character === "{") {
      return index;
    }
    if (
      character === "("
      && index > 0
      && ["+", "@", "!"].includes(pattern[index - 1])
    ) {
      return index - 1;
    }
  }
  return -1;
}

function mayTraverseFromDynamicPattern(dynamicPart: string): boolean {
  return /(^|[\\/,{(|])\.\.($|[\\/,})|])/.test(dynamicPart)
    || /\{[^}]*[\\/][^}]*\}/.test(dynamicPart)
    || /\([^)]*[\\/][^)]*\)/.test(dynamicPart);
}
