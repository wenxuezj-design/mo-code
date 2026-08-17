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

    const modeDecision = this.modePolicy.evaluate(request);
    if (
      mode === "plan"
      && (
        request.permissionKind === "edit"
        || (
          request.permissionKind === "shell"
          && request.shellSemantics !== "readOnly"
        )
      )
    ) {
      return modeDecision;
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
        // 显式 ask 表示每次都必须询问，不能被授权记忆绕过。
        rememberable: false,
      };
    }

    if (this.findMatch("allow", request)) return { behavior: "allow" };
    return modeDecision;
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
     * 通过 tool.getPermissionDescriptor(input, context) 获得的
    */
    const actual = isFileRule
      ? normalizePath(request.permissionTarget)
      : request.permissionTarget;

    const source = compileTargetPattern(expected);
    // s 匹配换行，支持多行 shell 命令
    // u 支持 unicode 字符
    return new RegExp(`^${source}$`, "su").test(actual);
  };
}

/**
 * 未转义的 * 是通配符；\* 和 \\ 分别匹配普通星号和反斜杠。
 * 文件规则会先统一路径分隔符，因此这里的转义主要用于 Shell 精确规则。
 */
function compileTargetPattern(pattern: string): string {
  let source = "";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === "*") {
      source += ".*";
      continue;
    }
    if (character === "\\") {
      const next = pattern[index + 1];
      if (next === "*" || next === "\\") {
        source += escapeRegExp(next);
        index++;
        continue;
      }
    }
    source += escapeRegExp(character);
  }
  return source;
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
