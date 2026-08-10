import { resolve } from "node:path";

import type { PermissionRuleSetting } from "./permission-settings.ts";
import { PermissionModePolicy } from "./permission-mode-policy.ts";
import type {
  PermissionDecision,
  PermissionPolicy,
  PermissionRequest,
} from "./types.ts";

type CompiledPermissionRule = PermissionRuleSetting & {
  toolName: string;
  matchesRequest: ((request: PermissionRequest) => boolean) | undefined;
};

export class PermissionRulePolicy implements PermissionPolicy {
  private readonly rules: readonly CompiledPermissionRule[];
  private readonly modePolicy: PermissionModePolicy;

  constructor(
    rules: readonly PermissionRuleSetting[],
    modePolicy: PermissionModePolicy,
    knownToolNames: Iterable<string>,
  ) {
    const knownTools = new Set(knownToolNames);
    this.rules = rules.map((rule) => compileRule(rule, knownTools));
    this.modePolicy = modePolicy;
  }

  evaluate(request: PermissionRequest): PermissionDecision {
    const mode = this.modePolicy.getMode();
    if (mode === "bypassPermissions") return { behavior: "allow" };

    const denyRule = this.findMatch("deny", request);
    if (denyRule) {
      return {
        behavior: "deny",
        reason: formatReason(denyRule, "denies this action"),
      };
    }

    if (
      mode === "plan"
      && (request.permissionKind === "edit" || request.permissionKind === "shell")
    ) {
      return this.modePolicy.evaluate(request);
    }

    const askRule = this.findMatch("ask", request);
    if (askRule) {
      if (mode === "dontAsk") {
        return {
          behavior: "deny",
          reason: formatReason(
            askRule,
            "requires confirmation, but dontAsk mode blocks prompts",
          ),
        };
      }
      return {
        behavior: "ask",
        reason: formatReason(askRule, "requires confirmation"),
      };
    }

    if (this.findMatch("allow", request)) return { behavior: "allow" };
    return this.modePolicy.evaluate(request);
  }

  private findMatch(
    behavior: PermissionRuleSetting["behavior"],
    request: PermissionRequest,
  ): CompiledPermissionRule | undefined {
    return this.rules.find((rule) => {
      if (rule.behavior !== behavior || rule.toolName !== request.toolName) {
        return false;
      }
      return rule.matchesRequest?.(request) ?? true;
    });
  }
}

function compileRule(
  setting: PermissionRuleSetting,
  knownToolNames: ReadonlySet<string>,
): CompiledPermissionRule {
  const raw = setting.raw.trim();
  if (raw.length === 0) throw invalidRule(setting, "rule is empty");

  const openParen = raw.indexOf("(");
  let toolName: string;
  let specifier: string | undefined;

  if (openParen === -1) {
    if (raw.includes(")")) throw invalidRule(setting, "unmatched parenthesis");
    toolName = raw;
  } else {
    if (openParen === 0 || !raw.endsWith(")")) {
      throw invalidRule(setting, "malformed tool(specifier) syntax");
    }
    toolName = raw.slice(0, openParen).trim();
    specifier = raw.slice(openParen + 1, -1);
    if (specifier.trim().length === 0) {
      throw invalidRule(setting, "specifier is empty");
    }
  }

  if (!knownToolNames.has(toolName)) {
    throw invalidRule(setting, `unknown tool "${toolName}"`);
  }

  return {
    ...setting,
    // 提取出来的工具名
    toolName,
    matchesRequest: specifier === undefined
      ? undefined
      : compileTargetMatcher(specifier),
  };
}

/** 创建匹配函数 */
function compileTargetMatcher(
  /** 规则配置里的限定条件 */
  specifier: string,
): (request: PermissionRequest) => boolean {
  return (request) => {
    const isFileRule = request.permissionKind === "read"
      || request.permissionKind === "edit";
    const expected = isFileRule
      ? normalizePath(resolve(request.cwd, normalizePath(specifier)))
      : specifier;
    /** permissionTarget 是执行时真正的目标或路径
     * 通过 tool.getPermissionTarget(input, context) 获得的
    */
    const actual = isFileRule
      ? normalizePath(request.permissionTarget)
      : request.permissionTarget;

    if (!expected.includes("*")) return actual === expected;

    const source = expected
      .split("*")
      .map(escapeRegExp)
      .join(".*");
    // s 匹配换行，支持多行 shell 命令
    // u 支持 unicode 字符
    return new RegExp(`^${source}$`, "su").test(actual);
  };
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function invalidRule(setting: PermissionRuleSetting, detail: string): Error {
  return new Error(
    `Invalid permission rule "${setting.raw}" from ${setting.sourcePath}: ${detail}`,
  );
}

function formatReason(rule: CompiledPermissionRule, outcome: string): string {
  return `Permission rule "${rule.raw}" from ${rule.sourcePath} ${outcome}`;
}
