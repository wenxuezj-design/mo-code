import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

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
};

type LoadPermissionSettingsOptions = {
  cwd: string;
  homeDir?: string;
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

  const projectDir = findProjectSettingsDirectory(options.cwd, homeDir);
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
  for (const source of sources) {
    const settings = loadSettingsFile(source);
    if (!settings) continue;

    loaded.rules.push(...settings.rules);
    if (settings.defaultMode !== undefined) {
      loaded.defaultMode = settings.defaultMode;
      loaded.defaultModeSource = source;
    }
  }
  return loaded;
}

function findProjectSettingsDirectory(
  cwd: string,
  homeDir: string,
): string | undefined {
  let current = resolve(cwd);

  while (current !== homeDir) {
    const settingsDir = join(current, ".mo-code");
    if (
      existsSync(join(settingsDir, "settings.json"))
      || existsSync(join(settingsDir, "settings.local.json"))
    ) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
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
