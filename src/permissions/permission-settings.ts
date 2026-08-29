import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { PermissionMode } from "./types.ts";

export type PermissionRuleSetting = {
  behavior: "allow" | "ask" | "deny";
  /** 表示配置文件中的原始规则字符串 */
  raw: string;
  sourceScope: "user" | "project" | "local";
  sourcePath: string;
};

export type PermissionSettingSource = Pick<
  PermissionRuleSetting,
  "sourceScope" | "sourcePath"
>;

export type LoadedPermissionSettings = {
  rules: PermissionRuleSetting[];
  defaultMode?: PermissionMode;
  defaultModeSource?: PermissionSettingSource;
  /** 未信任项目时，被项目信任门禁暂时过滤的权限扩张配置。 */
  trustGated?: TrustGatedPermissionSettings;
};

export type TrustGatedPermissionSettings = {
  rules: PermissionRuleSetting[];
  defaultMode?: PermissionMode;
  defaultModeSource?: PermissionSettingSource;
};

export type LoadPermissionSettingsOptions = {
  cwd: string;
  homeDir?: string;
  /** 项目配置向父目录查找时不能越过的目录，且该目录本身仍在查找范围内。 */
  trustRoot?: string;
  /** 省略时保持原有的全量加载行为；false 时过滤项目侧权限扩张配置。 */
  projectTrusted?: boolean;
};

type AddLocalPermissionAllowRuleOptions = {
  cwd: string;
  rule: string;
};

const PERMISSION_MODES = new Set<PermissionMode>([
  "default",
  "acceptEdits",
  "plan",
  "dontAsk",
  "bypassPermissions",
]);

const RULE_BEHAVIORS = ["allow", "ask", "deny"] as const;

export function loadPermissionSettings(
  options: LoadPermissionSettingsOptions,
): LoadedPermissionSettings {
  const homeDir = resolve(options.homeDir ?? homedir());
  const sources: PermissionSettingSource[] = [
    {
      sourceScope: "user",
      sourcePath: join(homeDir, ".mo-code", "settings.json"),
    },
  ];

  const projectDir = findProjectSettingsDirectory(
    options.cwd,
    homeDir,
    options.trustRoot,
  );
  if (projectDir) {
    sources.push(
      {
        sourceScope: "project",
        sourcePath: join(projectDir, ".mo-code", "settings.json"),
      },
      {
        sourceScope: "local",
        sourcePath: join(projectDir, ".mo-code", "settings.local.json"),
      },
    );
  }

  const loaded: LoadedPermissionSettings = { rules: [] };
  const trustGated: TrustGatedPermissionSettings = { rules: [] };
  for (const source of sources) {
    const settings = loadSettingsFile(source);
    if (!settings) continue;

    if (options.projectTrusted === false && source.sourceScope !== "user") {
      const allowedRules = settings.rules.filter(
        (rule) => rule.behavior === "allow",
      );
      const restrictiveRules = settings.rules.filter(
        (rule) => rule.behavior !== "allow",
      );
      loaded.rules.push(...restrictiveRules);
      trustGated.rules.push(...allowedRules);
      if (settings.defaultMode !== undefined) {
        trustGated.defaultMode = settings.defaultMode;
        trustGated.defaultModeSource = source;
      }
      continue;
    }

    loaded.rules.push(...settings.rules);
    if (settings.defaultMode !== undefined) {
      loaded.defaultMode = settings.defaultMode;
      loaded.defaultModeSource = source;
    }
  }
  if (
    trustGated.rules.length > 0
    || trustGated.defaultMode !== undefined
  ) {
    loaded.trustGated = trustGated;
  }
  return loaded;
}

/**
 * 把确认界面生成的规则写入项目本地配置。
 * 优先复用信任根内最近的设置根；没有时写到最近 Git 根，非 Git 则写到 cwd。
 */
export function addLocalPermissionAllowRule(
  options: AddLocalPermissionAllowRuleOptions,
): void {
  const cwd = resolve(options.cwd);
  const trustRoot = findGitRoot(cwd) ?? cwd;
  const settingsRoot = findExistingSettingsDirectory(cwd, trustRoot)
    ?? trustRoot;
  const settingsPath = join(settingsRoot, ".mo-code", "settings.local.json");
  const settings = readWritableSettings(settingsPath);
  const permissions = getWritablePermissions(settings, settingsPath);
  const allow = getWritableAllowRules(permissions, settingsPath);

  if (allow.includes(options.rule)) return;
  allow.push(options.rule);
  permissions.allow = allow;
  settings.permissions = permissions;

  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
}

function findProjectSettingsDirectory(
  cwd: string,
  homeDir: string,
  trustRoot?: string,
): string | undefined {
  let current = resolve(cwd);
  const boundary = trustRoot === undefined ? undefined : resolve(trustRoot);

  if (boundary !== undefined && !isWithinDirectory(current, boundary)) {
    return undefined;
  }

  while (current !== homeDir) {
    const settingsDir = join(current, ".mo-code");
    if (
      existsSync(join(settingsDir, "settings.json"))
      || existsSync(join(settingsDir, "settings.local.json"))
    ) {
      return current;
    }

    if (current === boundary) return undefined;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

function isWithinDirectory(path: string, directory: string): boolean {
  const relativePath = relative(directory, path);
  return relativePath === ""
    || (
      relativePath !== ".."
      && !relativePath.startsWith(`..${sep}`)
      && !isAbsolute(relativePath)
    );
}

function findExistingSettingsDirectory(
  cwd: string,
  boundary: string,
): string | undefined {
  const userHome = resolve(homedir());
  return findAncestor(cwd, (directory) => {
    // ~/.mo-code/settings.json 是用户级配置，不能作为项目本地授权的写入位置。
    if (directory === userHome) return false;
    const settingsDir = join(directory, ".mo-code");
    return existsSync(join(settingsDir, "settings.json"))
      || existsSync(join(settingsDir, "settings.local.json"));
  }, boundary);
}

function findGitRoot(cwd: string): string | undefined {
  return findAncestor(cwd, (directory) => existsSync(join(directory, ".git")));
}

function findAncestor(
  cwd: string,
  matches: (directory: string) => boolean,
  boundary?: string,
): string | undefined {
  let current = resolve(cwd);
  const stopDirectory = boundary === undefined ? undefined : resolve(boundary);
  if (stopDirectory !== undefined && !isWithinDirectory(current, stopDirectory)) {
    return undefined;
  }

  while (true) {
    if (matches(current)) return current;
    if (current === stopDirectory) return undefined;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function readWritableSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};

  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  } catch (error) {
    throw invalidSettings(path, `cannot update file: ${getErrorMessage(error)}`);
  }
  if (!isRecord(value)) {
    throw invalidSettings(path, "settings must be an object");
  }
  return value;
}

function getWritablePermissions(
  settings: Record<string, unknown>,
  path: string,
): Record<string, unknown> {
  const permissions = settings.permissions;
  if (permissions === undefined) return {};
  if (!isRecord(permissions)) {
    throw invalidSettings(path, "permissions must be an object");
  }
  return permissions;
}

function getWritableAllowRules(
  permissions: Record<string, unknown>,
  path: string,
): string[] {
  const allow = permissions.allow;
  if (allow === undefined) return [];
  if (!Array.isArray(allow) || allow.some((rule) => typeof rule !== "string")) {
    throw invalidSettings(path, "permissions.allow must be a string array");
  }
  return [...allow];
}

function loadSettingsFile(
  source: PermissionSettingSource,
): Pick<LoadedPermissionSettings, "rules" | "defaultMode"> | undefined {
  if (!existsSync(source.sourcePath)) return undefined;

  let contents: string;
  try {
    contents = readFileSync(source.sourcePath, "utf-8");
  } catch (error) {
    throw invalidSettings(
      source.sourcePath,
      `cannot read file: ${getErrorMessage(error)}`,
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch {
    throw invalidSettings(source.sourcePath, "invalid JSON");
  }

  if (!isRecord(value)) {
    throw invalidSettings(source.sourcePath, "settings must be an object");
  }

  const permissions = value.permissions;
  if (permissions === undefined) return { rules: [] };
  if (!isRecord(permissions)) {
    throw invalidSettings(source.sourcePath, "permissions must be an object");
  }

  const rules: PermissionRuleSetting[] = [];
  for (const behavior of RULE_BEHAVIORS) {
    const values = permissions[behavior];
    if (values === undefined) continue;
    if (!Array.isArray(values)) {
      throw invalidSettings(
        source.sourcePath,
        `permissions.${behavior} must be an array`,
      );
    }

    for (const [index, raw] of values.entries()) {
      if (typeof raw !== "string") {
        throw invalidSettings(
          source.sourcePath,
          `permissions.${behavior}[${index}] must be a string`,
        );
      }
      rules.push({ ...source, behavior, raw });
    }
  }

  const defaultMode = permissions.defaultMode;
  if (defaultMode === undefined) return { rules };
  if (
    typeof defaultMode !== "string"
    || !PERMISSION_MODES.has(defaultMode as PermissionMode)
  ) {
    throw invalidSettings(
      source.sourcePath,
      "permissions.defaultMode must be a valid permission mode",
    );
  }

  return { rules, defaultMode: defaultMode as PermissionMode };
}

function invalidSettings(path: string, reason: string): Error {
  return new Error(`Invalid permission settings at ${path}: ${reason}`);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
