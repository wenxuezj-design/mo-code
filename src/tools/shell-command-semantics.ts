import type { ShellCommandSemantics } from "../permissions/index.ts";

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

/** 只把能够完整识别的命令标记为只读，其余命令保守回退。 */
export function classifyShellCommand(command: string): ShellCommandSemantics {
  const scan = scanShellCommand(command.trim());
  if (scan.invalid || scan.complex || scan.segments.length === 0) {
    return "unknown";
  }
  if (scan.hasOutputRedirection) return "mutating";
  if (scan.hasInputRedirection) return "unknown";

  const classifications = scan.segments.map(classifySimpleCommand);
  if (classifications.includes("mutating")) return "mutating";
  if (classifications.includes("unknown")) return "unknown";
  return "readOnly";
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

function classifySimpleCommand(command: string): ShellCommandSemantics {
  const tokens = tokenize(command);
  if (tokens.length === 0 || isEnvironmentAssignment(tokens[0])) return "unknown";

  const executable = tokens[0];
  const arguments_ = tokens.slice(1);
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

function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let quote: "single" | "double" | undefined;
  let escaped = false;

  const pushToken = () => {
    if (started) tokens.push(current);
    current = "";
    started = false;
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
      escaped = true;
      started = true;
    } else if (quote === "double") {
      if (character === '"') quote = undefined;
      else current += character;
      started = true;
    } else if (character === "'") {
      quote = "single";
      started = true;
    } else if (character === '"') {
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
