import { resolve } from "node:path";

import type { PermissionRuleSetting } from "./permission-settings.ts";
import { PermissionModePolicy } from "./permission-mode-policy.ts";
import {
  PathBoundary,
  type PathBoundaryAssessment,
  type ResolvedFilesystemAccess,
} from "./path-boundary.ts";
import type {
  PermissionDecision,
  PermissionPolicy,
  PermissionRequest,
} from "./types.ts";

type CompiledPermissionRule = PermissionRuleSetting & {
  toolName: string;
  matchesRequest: (
    request: PermissionRequest,
    permissionTarget?: string,
  ) => boolean;
};

type PermissionRulePolicyOptions = {
  pathBoundary?: PathBoundary;
};

export class PermissionRulePolicy implements PermissionPolicy {
  private readonly rules: readonly CompiledPermissionRule[];
  private readonly modePolicy: PermissionModePolicy;
  private readonly pathBoundary: PathBoundary;

  constructor(
    rules: readonly PermissionRuleSetting[],
    modePolicy: PermissionModePolicy,
    knownToolNames: Iterable<string>,
    options: PermissionRulePolicyOptions = {},
  ) {
    const knownTools = new Set(knownToolNames);
    this.rules = rules.map((rule) => compileRule(rule, knownTools));
    this.modePolicy = modePolicy;
    this.pathBoundary = options.pathBoundary ?? new PathBoundary();
  }

  evaluate(request: PermissionRequest): PermissionDecision {
    const mode = this.modePolicy.getMode();
    const boundary = this.pathBoundary.inspect(
      request.cwd,
      request.filesystemAccesses,
    );

    // 根目录和 Home 的递归删除熔断不能被 bypassPermissions 跳过。
    if (
      (boundary.status === "known" || boundary.status === "unknown")
      && boundary.hasCatastrophicDelete === true
    ) {
      return boundaryPromptDecision(
        mode,
        formatBoundaryReason(
          "recursive deletion targets or may reach the filesystem root or Home directory",
          (boundary.accesses ?? []).filter((access) => access.catastrophicDelete),
        ),
      );
    }

    if (mode === "bypassPermissions") return { behavior: "allow" };

    const denyRule = this.findAnyMatch("deny", request, boundary);
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

    const guardedAccessDecision = this.evaluateGuardedAccess(mode, boundary);
    if (guardedAccessDecision) return guardedAccessDecision;

    const askRule = this.findAnyMatch("ask", request, boundary);
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

    if (this.isFullyAllowed(request, boundary)) return { behavior: "allow" };

    if (
      boundary.status === "known"
      && boundary.hasExternalPath
    ) {
      return boundaryPromptDecision(
        mode,
        formatBoundaryReason(
          "target is outside the primary working directory",
          boundary.accesses.filter((access) => access.outsideWorkingDirectory),
        ),
      );
    }

    // acceptEdits 只自动放行已经静态识别、完全位于普通工作目录内的文件修改命令。
    if (
      mode === "acceptEdits"
      && request.permissionKind === "shell"
      && request.shellSemantics === "mutating"
      && boundary.status === "known"
      && boundary.accesses.length > 0
      && boundary.accesses.some((access) => access.operation !== "read")
    ) {
      return { behavior: "allow" };
    }

    return modeDecision;
  }

  private evaluateGuardedAccess(
    mode: ReturnType<PermissionModePolicy["getMode"]>,
    boundary: PathBoundaryAssessment,
  ): PermissionDecision | undefined {
    if (boundary.status === "unknown") {
      return boundaryPromptDecision(
        mode,
        "Filesystem access cannot be determined reliably for this command",
      );
    }
    if (boundary.status !== "known") return undefined;

    if (boundary.hasUnresolvedPath) {
      return boundaryPromptDecision(
        mode,
        formatBoundaryReason(
          "target path cannot be resolved reliably",
          boundary.accesses.filter((access) =>
            access.resolvedPath === undefined
          ),
        ),
      );
    }
    if (boundary.hasProtectedPath) {
      return boundaryPromptDecision(
        mode,
        formatBoundaryReason(
          "write targets a protected project-control path",
          boundary.accesses.filter((access) => access.protectedPath),
        ),
      );
    }
    return undefined;
  }

  private findAnyMatch(
    behavior: PermissionRuleSetting["behavior"],
    request: PermissionRequest,
    boundary: PathBoundaryAssessment,
  ): CompiledPermissionRule | undefined {
    const candidates = ruleTargetCandidates(request, boundary);
    return this.rules.find((rule) => {
      if (rule.behavior !== behavior || rule.toolName !== request.toolName) {
        return false;
      }
      return candidates.some((target) => rule.matchesRequest(request, target));
    });
  }

  private isFullyAllowed(
    request: PermissionRequest,
    boundary: PathBoundaryAssessment,
  ): boolean {
    const rules = this.rules.filter((rule) =>
      rule.behavior === "allow" && rule.toolName === request.toolName
    );
    if (rules.length === 0) return false;

    // Shell 规则匹配完整命令；双路径匹配只适用于文件规则。
    if (
      (request.permissionKind !== "read" && request.permissionKind !== "edit")
      || boundary.status !== "known"
      || boundary.accesses.length === 0
    ) {
      return rules.some((rule) => rule.matchesRequest(request));
    }

    // 每个词法路径和真实目标都必须分别得到 allow，避免链接路径静默授权另一目录。
    return fileRuleTargetGroups(request, boundary.accesses).every((targets) =>
      targets.every((target) =>
        rules.some((rule) => rule.matchesRequest(request, target))
      )
    );
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
      ? () => true
      : compileTargetMatcher(specifier),
  };
}

/** 创建匹配函数 */
function compileTargetMatcher(
  /** 规则配置里的限定条件 */
  specifier: string,
): (request: PermissionRequest, permissionTarget?: string) => boolean {
  return (request, permissionTarget = request.permissionTarget) => {
    const isFileRule = request.permissionKind === "read"
      || request.permissionKind === "edit";
    const expected = isFileRule
      ? normalizePath(resolve(request.cwd, normalizePath(specifier)))
      : specifier;
    /** permissionTarget 是执行时真正的目标或路径
     * 通过 tool.getPermissionDescriptor(input, context) 获得的
    */
    const actual = isFileRule
      ? normalizePath(permissionTarget)
      : permissionTarget;

    const source = compileTargetPattern(expected);
    // s 匹配换行，支持多行 shell 命令
    // u 支持 unicode 字符
    return new RegExp(`^${source}$`, "su").test(actual);
  };
}

function ruleTargetCandidates(
  request: PermissionRequest,
  boundary: PathBoundaryAssessment,
): string[] {
  if (
    (request.permissionKind !== "read" && request.permissionKind !== "edit")
    || boundary.status !== "known"
    || boundary.accesses.length === 0
  ) {
    return [request.permissionTarget];
  }
  return fileRuleTargetGroups(request, boundary.accesses).flat();
}

function fileRuleTargetGroups(
  request: PermissionRequest,
  accesses: readonly ResolvedFilesystemAccess[],
): string[][] {
  return accesses.map((access) => {
    const requested = normalizePath(access.requestedPath);
    const resolved = access.resolvedPath === undefined
      ? undefined
      : normalizePath(access.resolvedPath);
    const permissionTarget = normalizePath(request.permissionTarget);
    const suffix = targetSuffix(permissionTarget, requested);

    if (suffix === undefined) {
      // 描述目标无法映射到声明的访问路径时保守处理：原目标与真实访问目标都要授权。
      return uniqueStrings([
        permissionTarget,
        requested,
        resolved,
      ]);
    }
    return uniqueStrings([
      permissionTarget,
      resolved === undefined ? undefined : `${resolved}${suffix}`,
    ]);
  });
}

function targetSuffix(target: string, base: string): string | undefined {
  if (target === base) return "";
  return target.startsWith(`${base}/`) ? target.slice(base.length) : undefined;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => value !== undefined))];
}

function boundaryPromptDecision(
  mode: ReturnType<PermissionModePolicy["getMode"]>,
  reason: string,
): PermissionDecision {
  if (mode === "dontAsk" || mode === "plan") {
    return {
      behavior: "deny",
      reason: `${reason}; permission mode "${mode}" blocks this confirmation`,
    };
  }
  return { behavior: "ask", reason, rememberable: false };
}

function formatBoundaryReason(
  detail: string,
  accesses: readonly ResolvedFilesystemAccess[],
): string {
  const targets = accesses.map((access) => {
    if (
      access.resolvedPath === undefined
      || access.resolvedPath === access.requestedPath
    ) {
      return access.requestedPath;
    }
    return `${access.requestedPath} -> ${access.resolvedPath}`;
  });
  return `Filesystem access requires confirmation: ${detail}${
    targets.length === 0 ? "" : ` (${uniqueStrings(targets).join(", ")})`
  }`;
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
