import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import {
  PathBoundary,
  type FilesystemAccess,
  type FilesystemAccessPlan,
  type ShellCommandSemantics,
} from "../permissions/index.ts";

const READ_ONLY_COMMANDS = new Set([
  "pwd",
  "ls",
  "cat",
  "head",
  "tail",
  "grep",
  "rg",
  "wc",
  "which",
  "file",
  "stat",
  "du",
  "df",
  "echo",
  "printf",
]);

const MUTATING_COMMANDS = new Set([
  "rm",
  "mv",
  "cp",
  "mkdir",
  "rmdir",
  "touch",
  "chmod",
  "chown",
  "chgrp",
  "ln",
  "install",
  "truncate",
  "tee",
  "dd",
]);

const SHELL_WRAPPERS = new Set([
  "env",
  "timeout",
  "sudo",
  "sh",
  "bash",
  "zsh",
  "dash",
  "fish",
  "eval",
  "command",
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "rev-parse",
  "ls-files",
  "ls-tree",
  "cat-file",
  "blame",
  "grep",
  "describe",
]);

const MUTATING_GIT_SUBCOMMANDS = new Set([
  "add",
  "apply",
  "checkout",
  "cherry-pick",
  "clean",
  "clone",
  "commit",
  "fetch",
  "init",
  "merge",
  "mv",
  "pull",
  "push",
  "rebase",
  "reset",
  "restore",
  "revert",
  "rm",
  "stash",
  "switch",
  "worktree",
]);

type ScanResult = {
  segments: string[];
  invalid: boolean;
  complex: boolean;
  hasInputRedirection: boolean;
  hasOutputRedirection: boolean;
};

export type ShellCommandAnalysis = {
  semantics: ShellCommandSemantics;
  filesystemAccesses?: FilesystemAccessPlan;
};

type SimpleCommandAnalysis = ShellCommandAnalysis & {
  participatesInFilesystemAnalysis: boolean;
  safeWithoutFilesystemAnalysis: boolean;
};

const PATH_COMMANDS = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "grep",
  "rg",
  "find",
  "stat",
  "rm",
  "mv",
  "cp",
  "mkdir",
  "rmdir",
  "touch",
]);

const POSSIBLE_PATH_COMMANDS = new Set(["wc", "file", "du", "df"]);

const NO_FILESYSTEM_COMMANDS = new Set(["pwd", "echo", "printf", "which"]);

const SYSTEM_EXECUTABLES = new Map([
  ["/bin/rm", "rm"],
  ["/usr/bin/rm", "rm"],
  ["/bin/find", "find"],
  ["/usr/bin/find", "find"],
]);

/** 一次分析 Shell 语义和能够可靠确定的文件系统访问。 */
export function analyzeShellCommand(
  command: string,
  cwd = process.cwd(),
): ShellCommandAnalysis {
  const scan = scanShellCommand(removeShellLineContinuations(command.trim()));
  const analyses = scan.segments.map((segment) => analyzeSimpleCommand(segment, cwd));
  const hasAnalyzedFilesystemCommand = analyses.some(
    (analysis) => analysis.participatesInFilesystemAnalysis,
  );

  let semantics: ShellCommandSemantics;
  if (scan.invalid || scan.complex || scan.segments.length === 0) {
    semantics = "unknown";
  } else if (scan.hasOutputRedirection) {
    semantics = "mutating";
  } else if (scan.hasInputRedirection) {
    semantics = "unknown";
  } else {
    const classifications = analyses.map((analysis) => analysis.semantics);
    semantics = classifications.includes("mutating")
      ? "mutating"
      : classifications.includes("unknown")
      ? "unknown"
      : "readOnly";
  }

  const partialCatastrophicDeletes = findPartialCatastrophicDeletes(
    analyses,
    cwd,
  );
  const hasCatastrophicDeleteRisk = analyses.some((analysis) => (
    analysis.filesystemAccesses?.status === "unknown"
    && analysis.filesystemAccesses.catastrophicDeleteRisk === true
  ));
  const unknownFilesystemAccesses: FilesystemAccessPlan = {
    status: "unknown",
    ...(partialCatastrophicDeletes.length > 0
      ? { accesses: partialCatastrophicDeletes }
      : {}),
    ...(hasCatastrophicDeleteRisk ? { catastrophicDeleteRisk: true } : {}),
  };

  if (scan.hasInputRedirection || scan.hasOutputRedirection) {
    return { semantics, filesystemAccesses: unknownFilesystemAccesses };
  }
  if (scan.invalid || scan.complex) {
    return {
      semantics,
      ...(hasAnalyzedFilesystemCommand
        ? { filesystemAccesses: unknownFilesystemAccesses }
        : {}),
    };
  }

  const plans = analyses.flatMap((analysis) => (
    analysis.filesystemAccesses ? [analysis.filesystemAccesses] : []
  ));
  if (plans.some((plan) => plan.status === "unknown")) {
    return { semantics, filesystemAccesses: unknownFilesystemAccesses };
  }
  if (plans.length === 0) return { semantics };

  // acceptEdits 只能依据完整分析的复合命令自动放行。未知命令夹带 touch 等
  // 已识别修改命令时，不能只返回后者的局部访问计划。
  if (
    semantics !== "readOnly"
    && analyses.some((analysis) => (
      !analysis.participatesInFilesystemAnalysis
      && !analysis.safeWithoutFilesystemAnalysis
    ))
  ) {
    return { semantics, filesystemAccesses: unknownFilesystemAccesses };
  }

  return {
    semantics,
    filesystemAccesses: {
      status: "known",
      accesses: plans.flatMap((plan) => (
        plan.status === "known" ? plan.accesses : []
      )),
    },
  };
}

function removeShellLineContinuations(command: string): string {
  let result = "";
  let quote: "single" | "double" | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    if (escaped) {
      result += character;
      escaped = false;
      continue;
    }
    if (character === "'" && quote !== "double") {
      quote = quote === "single" ? undefined : "single";
      result += character;
      continue;
    }
    if (character === '"' && quote !== "single") {
      quote = quote === "double" ? undefined : "double";
      result += character;
      continue;
    }
    if (character === "\\" && quote !== "single") {
      if (command[index + 1] === "\n") {
        index++;
        continue;
      }
      if (command[index + 1] === "\r" && command[index + 2] === "\n") {
        index += 2;
        continue;
      }
      result += character;
      escaped = true;
      continue;
    }
    result += character;
  }
  return result;
}

function findPartialCatastrophicDeletes(
  analyses: SimpleCommandAnalysis[],
  cwd: string,
): FilesystemAccess[] {
  const recursiveDeletes = analyses.flatMap((analysis) => {
    const plan = analysis.filesystemAccesses;
    const accesses = plan?.status === "known"
      ? plan.accesses
      : plan?.accesses ?? [];
    return accesses
      .filter((access) =>
        access.operation === "delete" && access.recursive === true
      )
      .map((access) => ({
        ...access,
        path: expandHomeReference(access.path) ?? access.path,
      }));
  });
  if (recursiveDeletes.length === 0) return [];

  const assessment = new PathBoundary().inspect(cwd, {
    status: "known",
    accesses: recursiveDeletes,
  });
  if (assessment.status !== "known") return [];
  return assessment.accesses
    .filter((access) => access.catastrophicDelete)
    .map(({ path, operation, recursive }) => ({ path, operation, recursive }));
}

function expandHomeReference(path: string): string | undefined {
  const match = /^(?:\$HOME|\$\{HOME\})(\/.*)?$/.exec(path);
  if (!match) return undefined;
  return resolve(homedir(), `.${match[1] ?? ""}`);
}

function scanShellCommand(command: string): ScanResult {
  const segments: string[] = [];
  let current = "";
  let quote: "single" | "double" | undefined;
  let escaped = false;
  let invalid = command.length === 0;
  let complex = false;
  let hasInputRedirection = false;
  let hasOutputRedirection = false;

  const pushSegment = () => {
    const segment = current.trim();
    if (segment.length === 0) invalid = true;
    else segments.push(segment);
    current = "";
  };

  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    const next = command[index + 1];

    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (quote === "single") {
      current += character;
      if (character === "'") quote = undefined;
      continue;
    }
    if (character === "\\") {
      current += character;
      escaped = true;
      continue;
    }
    if (quote === "double") {
      current += character;
      if (character === '"') quote = undefined;
      else if (character === "`" || character === "$") {
        complex = true;
      }
      continue;
    }
    if (character === "'") {
      quote = "single";
      current += character;
      continue;
    }
    if (character === '"') {
      quote = "double";
      current += character;
      continue;
    }

    if (
      character === "`"
      || character === "$"
      || character === "("
      || character === ")"
      || character === "{"
      || character === "}"
      || character === "*"
      || character === "?"
      || character === "["
    ) {
      complex = true;
      current += character;
      continue;
    }
    if (character === "&" && next === ">") {
      hasOutputRedirection = true;
      current += "&>";
      index++;
      continue;
    }
    if (character === ">") {
      hasOutputRedirection = true;
      current += character;
      if (next === "&") {
        current += next;
        index++;
      }
      continue;
    }
    if (character === "<") {
      hasInputRedirection = true;
      current += character;
      if (next === ">") hasOutputRedirection = true;
      if (next === "&" || next === ">") {
        current += next;
        index++;
      }
      continue;
    }
    if (character === "\n" || character === ";") {
      pushSegment();
      continue;
    }
    if (character === "&") {
      pushSegment();
      if (next === "&") index++;
      continue;
    }
    if (character === "|") {
      pushSegment();
      if (next === "|" || next === "&") index++;
      continue;
    }

    current += character;
  }

  if (quote || escaped) invalid = true;
  if (current.trim().length > 0) pushSegment();
  else if (segments.length > 0) invalid = true;

  return {
    segments,
    invalid,
    complex,
    hasInputRedirection,
    hasOutputRedirection,
  };
}

function analyzeSimpleCommand(command: string, cwd: string): SimpleCommandAnalysis {
  const prefix = stripCommandPrefixes(tokenize(command));
  const tokens = prefix.tokens;
  if (tokens.length === 0) {
    return {
      semantics: "unknown",
      participatesInFilesystemAnalysis: false,
      safeWithoutFilesystemAnalysis: false,
    };
  }

  const executable = normalizeExecutable(tokens[0].value);
  const arguments_ = tokens.slice(1);
  const values = arguments_.map((token) => token.value);
  const semantics = classifySimpleCommand(executable, values);
  const participatesInFilesystemAnalysis = PATH_COMMANDS.has(executable)
    || POSSIBLE_PATH_COMMANDS.has(executable);

  if (!participatesInFilesystemAnalysis) {
    return {
      semantics: prefix.unsafe ? "unknown" : semantics,
      participatesInFilesystemAnalysis: false,
      safeWithoutFilesystemAnalysis: !prefix.unsafe
        && NO_FILESYSTEM_COMMANDS.has(executable),
    };
  }

  const filesystemAccesses = PATH_COMMANDS.has(executable)
    ? analyzePathCommand(executable, arguments_, semantics, cwd)
    : analyzePossiblePathCommand(executable, arguments_);
  return {
    semantics: prefix.unsafe ? "unknown" : semantics,
    participatesInFilesystemAnalysis: true,
    safeWithoutFilesystemAnalysis: false,
    filesystemAccesses: prefix.unsafe
      ? markFilesystemPlanUnknown(filesystemAccesses)
      : filesystemAccesses,
  };
}

function stripCommandPrefixes(tokens: ShellToken[]): {
  tokens: ShellToken[];
  unsafe: boolean;
} {
  let index = 0;
  let unsafe = false;
  while (index < tokens.length) {
    const token = tokens[index];
    if (
      !token.startsWithQuotedOrEscapedCharacter
      && isEnvironmentAssignment(token.value)
    ) {
      unsafe = true;
      index++;
      continue;
    }
    if (!token.startsWithQuotedOrEscapedCharacter) {
      const redirection = /^(?:(?:\d+)?(?:>>?|<<?|<>|>&|<&)|&>)(.*)$/.exec(
        token.value,
      );
      if (redirection) {
        unsafe = true;
        index++;
        if (redirection[1] === "" && index < tokens.length) index++;
        continue;
      }
    }
    break;
  }
  return { tokens: tokens.slice(index), unsafe };
}

function markFilesystemPlanUnknown(
  plan: FilesystemAccessPlan | undefined,
): FilesystemAccessPlan | undefined {
  if (!plan) return undefined;
  const accesses = plan.accesses;
  return {
    status: "unknown",
    ...(accesses?.length ? { accesses } : {}),
    ...(plan.status === "unknown" && plan.catastrophicDeleteRisk
      ? { catastrophicDeleteRisk: true }
      : {}),
  };
}

function normalizeExecutable(executable: string): string {
  // 只识别固定系统位置。`./rm` 或 `/tmp/find` 可能是任意同名程序，不能
  // 因 basename 相同而获得内置命令的自动授权语义。
  return SYSTEM_EXECUTABLES.get(executable) ?? executable;
}

function classifySimpleCommand(
  executable: string,
  arguments_: string[],
): ShellCommandSemantics {
  if (SHELL_WRAPPERS.has(executable)) return "unknown";
  if (MUTATING_COMMANDS.has(executable)) return "mutating";
  if (executable === "find") return classifyFind(arguments_);
  if (executable === "git") return classifyGit(arguments_);
  if (!READ_ONLY_COMMANDS.has(executable)) return "unknown";

  if (
    executable === "rg"
    && arguments_.some((argument) => (
      argument === "--pre"
      || argument.startsWith("--pre=")
      || /^-[^-]*z/.test(argument)
      || argument === "--search-zip"
    ))
  ) {
    return "unknown";
  }
  if (
    executable === "file"
    && arguments_.some((argument) => (
      /^-[^-]*C/.test(argument)
      || matchesLongOption(argument, "--compile")
    ))
  ) {
    return "mutating";
  }
  if (
    executable === "printf"
    && arguments_.some((argument) => argument.startsWith("-v"))
  ) {
    return "mutating";
  }
  return "readOnly";
}

type ShellToken = {
  value: string;
  startsWithQuotedOrEscapedCharacter: boolean;
};

type OperandParserOptions = {
  shortFlags: string;
  shortValueOptions?: string;
  longFlags: Set<string>;
  longOptionalValueOptions?: Set<string>;
  longValueOptions?: Set<string>;
};

const EMPTY_OPTIONS = new Set<string>();

function analyzePathCommand(
  executable: string,
  arguments_: ShellToken[],
  semantics: ShellCommandSemantics,
  cwd: string,
): FilesystemAccessPlan {
  switch (executable) {
    case "ls":
      if (
        hasShortOption(arguments_, "R")
        && hasShortOption(arguments_, "L")
      ) {
        return { status: "unknown" };
      }
      return analyzeSimpleReadCommand(arguments_, {
        // BSD/macOS 的 -I/-T/-w 是无值 flag；GNU 中部分形式可能带值。
        // 统一按 flag 处理会在 GNU 上多检查一个操作数，但不会吞掉真实路径。
        shortFlags: "AabBcCdDfFghHiklLmnopqQrRsStuUvxX1ITw",
        longFlags: new Set([
          "--all", "--almost-all", "--author", "--classify", "--directory",
          "--dereference-command-line", "--file-type", "--group-directories-first",
          "--help", "--hide-control-chars", "--human-readable", "--inode",
          "--literal", "--no-group", "--numeric-uid-gid", "--quote-name",
          "--recursive", "--reverse", "--show-control-chars", "--size",
          "--version", "--zero",
        ]),
        longOptionalValueOptions: new Set(["--color"]),
        longValueOptions: new Set([
          "--block-size", "--format", "--hide", "--ignore",
          "--indicator-style", "--quoting-style", "--sort", "--tabsize",
          "--time", "--time-style", "--width",
        ]),
      }, true);
    case "cat":
      return analyzeSimpleReadCommand(arguments_, {
        shortFlags: "AbenstTuv",
        longFlags: new Set([
          "--number", "--number-nonblank", "--show-all", "--show-ends",
          "--show-nonprinting", "--show-tabs", "--squeeze-blank", "--help",
          "--version",
        ]),
      });
    case "head":
    case "tail":
      return analyzeSimpleReadCommand(arguments_, {
        shortFlags: executable === "head" ? "qvz" : "fFqvzr",
        shortValueOptions: "cn",
        longFlags: new Set([
          "--quiet", "--silent", "--verbose", "--zero-terminated", "--follow",
          "--retry", "--help", "--version",
        ]),
        longValueOptions: new Set([
          "--bytes", "--lines", "--pid", "--sleep-interval",
          "--max-unchanged-stats",
        ]),
      });
    case "grep":
      return analyzeGrep(arguments_);
    case "rg":
      return analyzeRipgrep(arguments_);
    case "find":
      return analyzeFind(arguments_, semantics);
    case "stat":
      return analyzeSimpleReadCommand(arguments_, {
        // GNU 的 -f/-t 是 flag，BSD 中可能带格式值。按 flag 解析虽然可能
        // 产生额外询问，但不会把后续真实文件路径吞作格式值。
        shortFlags: "FLlnqrsxft",
        longFlags: new Set([
          "--dereference", "--file-system", "--terse", "--help", "--version",
        ]),
        longValueOptions: new Set(["--format", "--printf"]),
      });
    case "rm":
      return analyzeRm(arguments_, cwd);
    case "cp":
      return analyzeCopyOrMove(arguments_, "cp", cwd);
    case "mv":
      return analyzeCopyOrMove(arguments_, "mv", cwd);
    case "mkdir":
      return analyzeSingleOperationCommand(arguments_, "write", {
        shortFlags: "pv",
        shortValueOptions: "m",
        longFlags: new Set(["--parents", "--verbose", "--help", "--version"]),
        longOptionalValueOptions: new Set(["--context"]),
        longValueOptions: new Set(["--mode"]),
      });
    case "rmdir":
      return analyzeSingleOperationCommand(arguments_, "delete", {
        shortFlags: "pv",
        longFlags: new Set([
          "--ignore-fail-on-non-empty", "--parents", "--verbose", "--help",
          "--version",
        ]),
      });
    case "touch":
      return analyzeTouch(arguments_);
    default:
      return { status: "unknown" };
  }
}

function analyzeSimpleReadCommand(
  arguments_: ShellToken[],
  options: OperandParserOptions,
  defaultsToCwd = false,
): FilesystemAccessPlan {
  const operands = parseOperands(arguments_, options);
  if (!operands) return { status: "unknown" };
  const paths = operands.filter((operand) => operand.value !== "-");
  if (paths.length === 0 && defaultsToCwd) {
    return knownAccesses([{ path: ".", operation: "read" }]);
  }
  return accessesFromTokens(paths, "read");
}

function analyzeGrep(arguments_: ShellToken[]): FilesystemAccessPlan {
  // -R 会在递归搜索时跟随目录中的符号链接，起始路径不足以证明边界。
  if (hasShortOption(arguments_, "R")) return { status: "unknown" };
  if (hasPathValuedOption(arguments_, ["--exclude-from"])) {
    return { status: "unknown" };
  }
  const patternFiles: ShellToken[] = [];
  const operands: ShellToken[] = [];
  let patternProvided = false;
  let recursive = false;
  let optionsEnded = false;

  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    const value = argument.value;
    if (!optionsEnded && value === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && (value === "-e" || value === "--regexp")) {
      if (!arguments_[index + 1]) return { status: "unknown" };
      patternProvided = true;
      index++;
      continue;
    }
    if (!optionsEnded && (value.startsWith("--regexp=") || /^-e.+/.test(value))) {
      patternProvided = true;
      continue;
    }
    if (!optionsEnded && (value === "-f" || value === "--file")) {
      const file = arguments_[index + 1];
      if (!file) return { status: "unknown" };
      patternFiles.push(file);
      patternProvided = true;
      index++;
      continue;
    }
    if (!optionsEnded && value.startsWith("--file=")) {
      patternFiles.push(inlineOptionToken(value));
      patternProvided = true;
      continue;
    }
    if (!optionsEnded && (value === "-r" || value === "-R" || value === "--recursive")) {
      recursive = true;
      continue;
    }
    if (!optionsEnded && value.startsWith("-") && value !== "-") {
      const consumed = consumeKnownOption(arguments_, index, GREP_OPTIONS);
      if (consumed === undefined) return { status: "unknown" };
      index = consumed;
      continue;
    }
    operands.push(argument);
  }

  const files = patternProvided ? operands : operands.slice(1);
  const paths = [...patternFiles, ...files.filter((file) => file.value !== "-")];
  if (recursive && files.length === 0) {
    paths.push(literalToken("."));
  }
  return accessesFromTokens(paths, "read");
}

const GREP_OPTIONS: OperandParserOptions = {
  shortFlags: "EFGHILZabcdhilnoqsvwxy",
  shortValueOptions: "ABCm",
  longFlags: new Set([
    "--basic-regexp", "--extended-regexp", "--fixed-strings", "--perl-regexp",
    "--ignore-case", "--no-ignore-case", "--word-regexp", "--line-regexp",
    "--null-data", "--no-messages", "--invert-match", "--version",
    "--help", "--line-number", "--with-filename", "--no-filename",
    "--only-matching", "--quiet", "--silent", "--binary-files-without-match",
    "--text", "--binary", "--directories-recurse", "--devices-skip",
    "--line-buffered", "--null", "--count", "--files-with-matches",
    "--files-without-match", "--color", "--colour",
  ]),
  longValueOptions: new Set([
    "--after-context", "--before-context", "--context", "--binary-files",
    "--devices", "--directories", "--exclude",
    "--exclude-dir", "--exclude-from", "--group-separator", "--include",
    "--label", "--max-count",
  ]),
};

function analyzeRipgrep(arguments_: ShellToken[]): FilesystemAccessPlan {
  // rg 默认递归；--follow/-L 会让工作目录内链接进入外部目录。
  if (
    hasShortOption(arguments_, "L")
    || arguments_.some((argument) => argument.value === "--follow")
  ) {
    return { status: "unknown" };
  }
  if (hasPathValuedOption(arguments_, ["--ignore-file"])) {
    return { status: "unknown" };
  }
  const patternFiles: ShellToken[] = [];
  const operands: ShellToken[] = [];
  let filesMode = false;
  let patternProvided = false;
  let optionsEnded = false;

  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    const value = argument.value;
    if (!optionsEnded && value === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && value === "--files") {
      filesMode = true;
      continue;
    }
    if (!optionsEnded && (value === "-e" || value === "--regexp")) {
      if (!arguments_[index + 1]) return { status: "unknown" };
      patternProvided = true;
      index++;
      continue;
    }
    if (!optionsEnded && (value.startsWith("--regexp=") || /^-e.+/.test(value))) {
      patternProvided = true;
      continue;
    }
    if (!optionsEnded && (value === "-f" || value === "--file")) {
      const file = arguments_[index + 1];
      if (!file) return { status: "unknown" };
      patternFiles.push(file);
      patternProvided = true;
      index++;
      continue;
    }
    if (!optionsEnded && value.startsWith("--file=")) {
      patternFiles.push(inlineOptionToken(value));
      patternProvided = true;
      continue;
    }
    if (!optionsEnded && value.startsWith("-") && value !== "-") {
      const consumed = consumeKnownOption(arguments_, index, RG_OPTIONS);
      if (consumed === undefined) return { status: "unknown" };
      index = consumed;
      continue;
    }
    operands.push(argument);
  }

  const searchPaths = filesMode
    ? operands
    : patternProvided
    ? operands
    : operands.slice(1);
  const paths = [
    ...patternFiles,
    ...searchPaths.filter((path) => path.value !== "-"),
  ];
  if (searchPaths.length === 0) paths.push(literalToken("."));
  return accessesFromTokens(paths, "read");
}

const RG_OPTIONS: OperandParserOptions = {
  shortFlags: "FHILMNSUuvVwxy",
  shortValueOptions: "ABCgjmrtT",
  longFlags: new Set([
    "--block-buffered", "--case-sensitive", "--column", "--count",
    "--count-matches", "--debug",
    "--files-with-matches", "--files-without-match", "--fixed-strings",
    "--follow", "--heading", "--help", "--hidden", "--ignore-case",
    "--invert-match", "--json", "--line-number", "--no-filename",
    "--no-heading", "--no-ignore", "--no-ignore-dot", "--no-ignore-global",
    "--no-ignore-parent", "--no-ignore-vcs", "--no-messages", "--no-unicode",
    "--null", "--null-data", "--one-file-system", "--only-matching",
    "--passthru", "--pcre2", "--pretty", "--quiet", "--smart-case",
    "--stats", "--text", "--trim", "--type-list", "--unrestricted",
    "--version", "--vimgrep", "--with-filename", "--word-regexp",
  ]),
  longValueOptions: new Set([
    "--after-context", "--before-context", "--color",
    "--colors", "--context", "--context-separator", "--dfa-size-limit",
    "--encoding", "--engine", "--field-context-separator", "--field-match-separator",
    "--glob", "--iglob", "--ignore-file", "--max-columns", "--max-count",
    "--max-depth", "--max-filesize", "--path-separator", "--regex-size-limit",
    "--replace", "--sort", "--sortr", "--type", "--type-add", "--type-clear",
    "--type-not",
  ]),
};

function analyzeFind(
  arguments_: ShellToken[],
  semantics: ShellCommandSemantics,
): FilesystemAccessPlan {
  const roots = extractFindRoots(arguments_);

  // find -delete 会递归遍历并删除根路径。整体仍标为 unknown，避免
  // acceptEdits 自动放行，但保留 root/Home 熔断所需的静态事实。
  if (
    semantics === "mutating"
    && arguments_.some((argument) => argument.value === "-delete")
  ) {
    const plan = accessesFromTokens(
      roots ?? findPotentialDeleteRoots(arguments_),
      "delete",
      true,
    );
    const followsDirectoryLinks = hasShortOption(arguments_, "L");
    return {
      status: "unknown",
      ...(plan.status === "known" ? { accesses: plan.accesses } : {}),
      ...(followsDirectoryLinks ? { catastrophicDeleteRisk: true } : {}),
    };
  }

  if (!roots) return { status: "unknown" };
  if (semantics !== "readOnly") return { status: "unknown" };
  if (hasShortOption(arguments_, "L")) return { status: "unknown" };
  if (
    arguments_.some((argument) => (
      ["-anewer", "-cnewer", "-files0-from", "-newer", "-samefile"]
        .includes(argument.value)
      || /^-newer[A-Za-z]{2}$/.test(argument.value)
    ))
  ) {
    return { status: "unknown" };
  }

  return accessesFromTokens(roots, "read");
}

function extractFindRoots(arguments_: ShellToken[]): ShellToken[] | undefined {
  let index = 0;
  while (["-H", "-L", "-P"].includes(arguments_[index]?.value)) index++;
  if (arguments_[index]?.value === "--") index++;
  else if (arguments_[index]?.value.startsWith("-")) {
    return undefined;
  }
  const roots: ShellToken[] = [];
  while (index < arguments_.length) {
    const argument = arguments_[index];
    if (
      argument.value.startsWith("-")
      || argument.value === "!"
      || argument.value === "("
    ) {
      break;
    }
    roots.push(argument);
    index++;
  }
  if (roots.length === 0) roots.push(literalToken("."));
  return roots;
}

function findPotentialDeleteRoots(arguments_: ShellToken[]): ShellToken[] {
  // 未支持的 find 全局选项可能出现在根路径之前。这里只为灾难删除熔断
  // 保留所有字面候选，后续 PathBoundary 只会留下实际 root/Home 目标。
  const candidates = arguments_.filter((argument) => (
    !argument.value.startsWith("-")
    && !["!", "(", ")"].includes(argument.value)
  ));
  return candidates.length > 0 ? candidates : [literalToken(".")];
}

function analyzeRm(
  arguments_: ShellToken[],
  cwd: string,
): FilesystemAccessPlan {
  const recursive = arguments_.some((argument) => (
    argument.value === "--recursive"
    || /^-[^-]*[rR]/.test(argument.value)
  ));
  const operands = parseOperands(arguments_, {
    shortFlags: "dfiIPRrvWx",
    longFlags: new Set([
      "--dir", "--force", "--interactive", "--one-file-system",
      "--no-preserve-root", "--preserve-root", "--recursive", "--verbose",
      "--help", "--version",
    ]),
  });
  if (!operands) {
    // 未识别选项可能是 --recursive 的合法缩写。无法证明非递归时，仍保留
    // root/Home 熔断事实；最多产生一次额外确认，不能让 bypass 漏过。
    const possiblyRecursive = recursive || arguments_.some((argument) =>
      argument.value.startsWith("-") && argument.value !== "--"
    );
    const possibleTargets = arguments_.filter((argument) =>
      !argument.value.startsWith("-") && argument.value !== "--"
    );
    const accesses = possibleTargets.flatMap((target) => {
      const path = normalizeLiteralPath(target);
      return path === undefined
        ? []
        : [{
          path,
          operation: "delete" as const,
          ...(possiblyRecursive ? { recursive: true } : {}),
        }];
    });
    return accesses.length === 0
      ? { status: "unknown" }
      : { status: "unknown", accesses };
  }
  const plan = accessesFromTokens(operands, "delete", recursive);
  if (
    plan.status === "known"
    && recursive
    && plan.accesses.some((access) => mayBeDirectory(cwd, access.path))
  ) {
    // 删除目录会间接影响任意深度的保护路径；本阶段不遍历整棵目录。
    return { status: "unknown", accesses: plan.accesses };
  }
  return plan;
}

function analyzeCopyOrMove(
  arguments_: ShellToken[],
  executable: "cp" | "mv",
  cwd: string,
): FilesystemAccessPlan {
  const parsed = parseCopyOrMoveOperands(arguments_, executable);
  if (!parsed || parsed.sources.length !== 1 || !parsed.target) {
    return { status: "unknown" };
  }
  const sourcePath = normalizeLiteralPath(parsed.sources[0]);
  if (sourcePath === undefined || mayBeDirectory(cwd, sourcePath)) {
    // 复制或移动目录可能间接影响其中任意深度的保护路径。
    return { status: "unknown" };
  }
  const destination = resolveCopyOrMoveDestination(
    parsed.sources[0],
    parsed.target,
    cwd,
  );
  if (!destination) return { status: "unknown" };

  const sourceOperation = executable === "cp" ? "read" : "delete";
  return combineKnownPlans([
    accessesFromTokens(parsed.sources, sourceOperation),
    accessesFromTokens([destination], "write"),
  ]);
}

function resolveCopyOrMoveDestination(
  source: ShellToken,
  target: ShellToken,
  cwd: string,
): ShellToken | undefined {
  const sourcePath = normalizeLiteralPath(source);
  const targetPath = normalizeLiteralPath(target);
  if (sourcePath === undefined || targetPath === undefined) return undefined;
  // target/link/../dir 的目录身份取决于先跟随 link 后的物理路径；这里不做
  // 第二套真实路径解析，直接交给边界门禁保守询问。
  if (hasParentTraversal(targetPath)) return undefined;

  let targetIsDirectory: boolean;
  try {
    targetIsDirectory = statSync(resolve(cwd, targetPath)).isDirectory();
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) return undefined;
    targetIsDirectory = false;
  }
  if (!targetIsDirectory) return target;

  const sourceName = basename(sourcePath);
  if (sourceName === "" || sourceName === "." || sourceName === "..") {
    return undefined;
  }
  return literalToken(join(targetPath, sourceName));
}

function parseCopyOrMoveOperands(
  arguments_: ShellToken[],
  executable: "cp" | "mv",
): { sources: ShellToken[]; target?: ShellToken } | undefined {
  const operands: ShellToken[] = [];
  let optionsEnded = false;
  const shortFlags = executable === "cp" ? "aHLPRdfilnpPrsvx" : "bfinvT";
  const longFlags = executable === "cp"
    ? new Set([
      "--archive", "--attributes-only", "--copy-contents", "--dereference",
      "--force", "--interactive", "--link", "--no-clobber", "--no-dereference",
      "--no-preserve-root", "--parents", "--preserve", "--recursive",
      "--reflink", "--remove-destination", "--sparse", "--strip-trailing-slashes",
      "--symbolic-link", "--update", "--verbose", "--one-file-system", "--help",
      "--version",
    ])
    : new Set([
      "--backup", "--debug", "--exchange", "--force", "--interactive",
      "--no-clobber", "--no-copy", "--no-target-directory", "--strip-trailing-slashes",
      "--update", "--verbose", "--help", "--version",
    ]);

  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    const value = argument.value;
    if (!optionsEnded && value === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && (value === "-t" || value === "--target-directory")) {
      return undefined;
    }
    if (!optionsEnded && value.startsWith("--target-directory=")) {
      return undefined;
    }
    if (!optionsEnded && executable === "cp" && value === "--parents") {
      return undefined;
    }
    if (!optionsEnded && (value === "-S" || value === "--suffix")) {
      if (!arguments_[index + 1]) return undefined;
      index++;
      continue;
    }
    if (!optionsEnded && (value.startsWith("-S") || value.startsWith("--suffix="))) {
      continue;
    }
    if (!optionsEnded && value.startsWith("--") && value.includes("=")) {
      const option = value.slice(0, value.indexOf("="));
      if (longFlags.has(option)) continue;
      return undefined;
    }
    if (!optionsEnded && value.startsWith("--")) {
      if (longFlags.has(value)) continue;
      return undefined;
    }
    if (!optionsEnded && value.startsWith("-") && value !== "-") {
      if (![...value.slice(1)].every((option) => shortFlags.includes(option))) {
        return undefined;
      }
      continue;
    }
    operands.push(argument);
  }

  return { sources: operands.slice(0, -1), target: operands.at(-1) };
}

function analyzeSingleOperationCommand(
  arguments_: ShellToken[],
  operation: FilesystemAccess["operation"],
  options: OperandParserOptions,
): FilesystemAccessPlan {
  const operands = parseOperands(arguments_, options);
  return operands
    ? accessesFromTokens(operands, operation)
    : { status: "unknown" };
}

function analyzeTouch(arguments_: ShellToken[]): FilesystemAccessPlan {
  const references: ShellToken[] = [];
  const targets: ShellToken[] = [];
  let optionsEnded = false;

  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    const value = argument.value;
    if (!optionsEnded && value === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && (value === "-r" || value === "--reference")) {
      const reference = arguments_[index + 1];
      if (!reference) return { status: "unknown" };
      references.push(reference);
      index++;
      continue;
    }
    if (!optionsEnded && value.startsWith("--reference=")) {
      references.push(inlineOptionToken(value));
      continue;
    }
    if (!optionsEnded && value.startsWith("-") && value !== "-") {
      const consumed = consumeKnownOption(arguments_, index, {
        shortFlags: "acfm",
        shortValueOptions: "dt",
        longFlags: new Set([
          "--no-create", "--help", "--version",
        ]),
        longValueOptions: new Set(["--date", "--time"]),
      });
      if (consumed === undefined) return { status: "unknown" };
      index = consumed;
      continue;
    }
    targets.push(argument);
  }

  return combineKnownPlans([
    accessesFromTokens(references, "read"),
    accessesFromTokens(targets, "write"),
  ]);
}

function analyzePossiblePathCommand(
  executable: string,
  arguments_: ShellToken[],
): FilesystemAccessPlan | undefined {
  if (hasPathValuedOption(arguments_, POSSIBLE_PATH_VALUE_OPTIONS[executable] ?? [])) {
    return { status: "unknown" };
  }
  const options = POSSIBLE_PATH_OPTIONS[executable];
  const operands = options ? parseOperands(arguments_, options) : undefined;
  if (!operands) return { status: "unknown" };
  return operands.some((operand) => operand.value !== "-")
    ? { status: "unknown" }
    : undefined;
}

const POSSIBLE_PATH_VALUE_OPTIONS: Record<string, string[]> = {
  wc: ["--files0-from"],
  file: ["-m", "--files-from", "--magic-file"],
  du: ["-X", "--exclude-from", "--files0-from"],
  df: [],
};

function hasPathValuedOption(
  arguments_: ShellToken[],
  options: readonly string[],
): boolean {
  return arguments_.some((argument) => options.some((option) => (
    argument.value === option
    || argument.value.startsWith(`${option}=`)
    || (
      option.startsWith("-")
      && !option.startsWith("--")
      && argument.value.startsWith(option)
    )
  )));
}

function hasShortOption(arguments_: ShellToken[], option: string): boolean {
  return arguments_.some((argument) => (
    argument.value.startsWith("-")
    && !argument.value.startsWith("--")
    && argument.value.slice(1).includes(option)
  ));
}

const POSSIBLE_PATH_OPTIONS: Record<string, OperandParserOptions> = {
  wc: {
    shortFlags: "cLlmw",
    longFlags: new Set([
      "--bytes", "--chars", "--lines", "--max-line-length", "--words",
      "--help", "--version",
    ]),
    longValueOptions: new Set(["--files0-from"]),
  },
  file: {
    shortFlags: "bCcdEhikLlNnprsSvzZ0",
    shortValueOptions: "eFfmP",
    longFlags: new Set([
      "--brief", "--compile", "--checking-printout", "--extension", "--help",
      "--keep-going", "--list", "--no-buffer", "--no-dereference",
      "--no-pad", "--preserve-date", "--print0", "--raw", "--special-files",
      "--version",
    ]),
    longValueOptions: new Set([
      "--exclude", "--exclude-quiet", "--separator", "--files-from",
      "--magic-file", "--parameter",
    ]),
  },
  du: {
    shortFlags: "HLPachklmsx",
    shortValueOptions: "Bd",
    longFlags: new Set([
      "--all", "--apparent-size", "--bytes", "--count-links", "--dereference",
      "--dereference-args", "--human-readable", "--inodes", "--one-file-system",
      "--separate-dirs", "--summarize", "--help", "--version",
    ]),
    longOptionalValueOptions: new Set(["--time"]),
    longValueOptions: new Set([
      "--block-size", "--exclude", "--exclude-from", "--files0-from",
      "--max-depth", "--threshold", "--time-style",
    ]),
  },
  df: {
    shortFlags: "HPTahil",
    shortValueOptions: "Btx",
    longFlags: new Set([
      "--all", "--human-readable", "--inodes", "--local", "--no-sync",
      "--portability", "--print-type", "--sync", "--total", "--help",
      "--version",
    ]),
    longValueOptions: new Set(["--block-size", "--exclude-type", "--type"]),
  },
};

function parseOperands(
  arguments_: ShellToken[],
  options: OperandParserOptions,
): ShellToken[] | undefined {
  const operands: ShellToken[] = [];
  let optionsEnded = false;

  for (let index = 0; index < arguments_.length; index++) {
    const value = arguments_[index].value;
    if (!optionsEnded && value === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && value.startsWith("-") && value !== "-") {
      const consumed = consumeKnownOption(arguments_, index, options);
      if (consumed === undefined) return undefined;
      index = consumed;
      continue;
    }
    operands.push(arguments_[index]);
  }
  return operands;
}

function consumeKnownOption(
  arguments_: ShellToken[],
  index: number,
  options: OperandParserOptions,
): number | undefined {
  const value = arguments_[index].value;
  const longOptionalValueOptions = options.longOptionalValueOptions
    ?? EMPTY_OPTIONS;
  const longValueOptions = options.longValueOptions ?? EMPTY_OPTIONS;
  if (value.startsWith("--")) {
    const equalsIndex = value.indexOf("=");
    const name = equalsIndex === -1 ? value : value.slice(0, equalsIndex);
    if (longOptionalValueOptions.has(name)) return index;
    if (longValueOptions.has(name)) {
      if (equalsIndex !== -1) return index;
      return arguments_[index + 1] ? index + 1 : undefined;
    }
    return options.longFlags.has(name) && equalsIndex === -1 ? index : undefined;
  }

  const characters = value.slice(1);
  for (let offset = 0; offset < characters.length; offset++) {
    const character = characters[offset];
    if (options.shortValueOptions?.includes(character)) {
      return offset < characters.length - 1
        ? index
        : arguments_[index + 1]
        ? index + 1
        : undefined;
    }
    if (!options.shortFlags.includes(character) && !/^[0-9]$/.test(character)) {
      return undefined;
    }
  }
  return index;
}

function accessesFromTokens(
  tokens: ShellToken[],
  operation: FilesystemAccess["operation"],
  recursive?: boolean,
): FilesystemAccessPlan {
  const accesses: FilesystemAccess[] = [];
  for (const token of tokens) {
    const path = normalizeLiteralPath(token);
    if (path === undefined) return { status: "unknown" };
    accesses.push({ path, operation, ...(recursive ? { recursive: true } : {}) });
  }
  return knownAccesses(accesses);
}

function normalizeLiteralPath(token: ShellToken): string | undefined {
  if (token.startsWithQuotedOrEscapedCharacter || !token.value.startsWith("~")) {
    return token.value;
  }
  if (token.value === "~") return homedir();
  if (token.value.startsWith("~/")) return join(homedir(), token.value.slice(2));
  return undefined;
}

function knownAccesses(accesses: FilesystemAccess[]): FilesystemAccessPlan {
  return { status: "known", accesses };
}

function combineKnownPlans(plans: FilesystemAccessPlan[]): FilesystemAccessPlan {
  if (plans.some((plan) => plan.status === "unknown")) {
    return { status: "unknown" };
  }
  return knownAccesses(plans.flatMap((plan) => (
    plan.status === "known" ? plan.accesses : []
  )));
}

function literalToken(value: string): ShellToken {
  return { value, startsWithQuotedOrEscapedCharacter: false };
}

function inlineOptionToken(value: string): ShellToken {
  return {
    value: value.slice(value.indexOf("=") + 1),
    startsWithQuotedOrEscapedCharacter: true,
  };
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error
    && "code" in error
    && error.code === code;
}

function mayBeDirectory(cwd: string, path: string): boolean {
  // `link/../file` 的物理语义取决于 link 的真实目标，不能先词法折叠后
  // 再判断源是否为目录。
  if (hasParentTraversal(path)) return true;
  try {
    return statSync(resolve(cwd, path)).isDirectory();
  } catch {
    return false;
  }
}

function hasParentTraversal(path: string): boolean {
  return path.split(/[\\/]/).includes("..");
}

function classifyFind(arguments_: string[]): ShellCommandSemantics {
  if (arguments_.some((argument) => (
    argument === "-delete"
    || argument === "-fprint"
    || argument === "-fprint0"
    || argument === "-fprintf"
    || argument === "-fls"
  ))) {
    return "mutating";
  }
  if (arguments_.some((argument) => (
    argument === "-exec"
    || argument === "-execdir"
    || argument === "-ok"
    || argument === "-okdir"
  ))) {
    return "unknown";
  }
  return "readOnly";
}

function classifyGit(arguments_: string[]): ShellCommandSemantics {
  const [subcommand, ...subcommandArguments] = arguments_;
  if (!subcommand || subcommand.startsWith("-")) return "unknown";
  if (hasGitOutputOption(subcommandArguments)) return "mutating";
  if (hasGitExternalExecutionOption(subcommandArguments)) return "unknown";
  if (READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return "readOnly";
  if (subcommand === "branch") return classifyGitList(subcommandArguments, "branch");
  if (subcommand === "tag") return classifyGitList(subcommandArguments, "tag");
  if (subcommand === "remote") return classifyGitRemote(subcommandArguments);
  if (MUTATING_GIT_SUBCOMMANDS.has(subcommand)) return "mutating";
  return "unknown";
}

function classifyGitList(
  arguments_: string[],
  command: "branch" | "tag",
): ShellCommandSemantics {
  if (arguments_.length === 0) return "readOnly";

  const mutationOptions = command === "branch"
    ? [
      "-d", "-D", "-m", "-M", "-c", "-C", "--delete", "--move",
      "--copy", "--edit-description", "--set-upstream-to",
      "--unset-upstream", "--track", "--no-track", "--create-reflog",
    ]
    : [
      "-d", "--delete", "-a", "--annotate", "-s", "--sign", "-u",
      "--local-user", "-f", "--force", "-m", "--message", "-F", "--file",
      "--cleanup", "--create-reflog",
    ];
  if (arguments_.some((argument) => mutationOptions.includes(argument))) {
    return "mutating";
  }
  if (command === "branch" && arguments_.length === 1 && arguments_[0] === "--show-current") {
    return "readOnly";
  }
  if (arguments_[0] === "--list") {
    return arguments_.slice(1).some((argument) => argument.startsWith("-"))
      ? "unknown"
      : "readOnly";
  }
  if (!arguments_[0].startsWith("-")) return "mutating";
  return "unknown";
}

function classifyGitRemote(arguments_: string[]): ShellCommandSemantics {
  if (arguments_.length === 0) return "readOnly";
  if (arguments_.length === 1 && ["-v", "--verbose"].includes(arguments_[0])) {
    return "readOnly";
  }

  const [subcommand, ...rest] = arguments_;
  if (subcommand === "get-url") {
    return rest.some((argument) => !argument.startsWith("-"))
      && rest.every((argument) => (
        !argument.startsWith("-") || argument === "--push" || argument === "--all"
      ))
      ? "readOnly"
      : "unknown";
  }
  if (subcommand === "show") {
    if (rest.length === 0) return "readOnly";
    const avoidsNetwork = rest.includes("-n") || rest.includes("--no-query");
    const hasUnknownOption = rest.some((argument) => (
      argument.startsWith("-")
      && argument !== "-n"
      && argument !== "--no-query"
    ));
    return avoidsNetwork && !hasUnknownOption
      ? "readOnly"
      : "unknown";
  }
  if ([
    "add",
    "rename",
    "remove",
    "rm",
    "set-head",
    "set-branches",
    "set-url",
    "prune",
    "update",
  ].includes(subcommand)) {
    return "mutating";
  }
  return "unknown";
}

function hasGitOutputOption(arguments_: string[]): boolean {
  return arguments_.some((argument) => matchesLongOption(argument, "--output"));
}

function hasGitExternalExecutionOption(arguments_: string[]): boolean {
  return arguments_.some((argument) => (
    argument.startsWith("-O")
    || [
      "--ext-diff",
      "--textconv",
      "--filters",
      "--open-files-in-pager",
    ].some((option) => matchesLongOption(argument, option))
  ));
}

function matchesLongOption(argument: string, option: string): boolean {
  const name = argument.split("=", 1)[0];
  return name.length > 2 && name.startsWith("--") && option.startsWith(name);
}

function isEnvironmentAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(token);
}

function tokenize(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let current = "";
  let started = false;
  let startsWithQuotedOrEscapedCharacter = false;
  let quote: "single" | "double" | undefined;
  let escaped = false;

  const pushToken = () => {
    if (started) tokens.push({ value: current, startsWithQuotedOrEscapedCharacter });
    current = "";
    started = false;
    startsWithQuotedOrEscapedCharacter = false;
  };

  for (const character of command) {
    if (escaped) {
      current += character;
      started = true;
      escaped = false;
    } else if (quote === "single") {
      if (character === "'") quote = undefined;
      else current += character;
      started = true;
    } else if (character === "\\") {
      if (!started) startsWithQuotedOrEscapedCharacter = true;
      escaped = true;
      started = true;
    } else if (quote === "double") {
      if (character === '"') quote = undefined;
      else current += character;
      started = true;
    } else if (character === "'") {
      if (!started) startsWithQuotedOrEscapedCharacter = true;
      quote = "single";
      started = true;
    } else if (character === '"') {
      if (!started) startsWithQuotedOrEscapedCharacter = true;
      quote = "double";
      started = true;
    } else if (/\s/.test(character)) {
      pushToken();
    } else {
      current += character;
      started = true;
    }
  }

  pushToken();
  return tokens;
}
