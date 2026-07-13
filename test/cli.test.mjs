import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import assert from "node:assert/strict";
import test from "node:test";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = resolve(projectRoot, "src", "cli.ts");

test("--help 和 -h 显示 CLI 帮助后退出", () => {
  for (const option of ["--help", "-h"]) {
    const result = spawnSync(
      process.execPath,
      ["--no-warnings", "--experimental-strip-types", cliPath, option],
      { cwd: projectRoot, encoding: "utf-8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /^Usage: mo-code \[options\] \[prompt\.\.\.\]/m);
    assert.match(result.stdout, /-h, --help/);
    assert.match(result.stdout, /-v, --version/);
    assert.match(result.stdout, /-p, --print/);
    assert.match(result.stdout, /--mortis/);
    assert.match(result.stdout, /--max-budget-usd <amount>/);
  }
});

test("--version 和 -v 显示当前版本后退出", () => {
  for (const option of ["--version", "-v"]) {
    const result = spawnSync(
      process.execPath,
      ["--no-warnings", "--experimental-strip-types", cliPath, option],
      { cwd: projectRoot, encoding: "utf-8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, "0.4.0 (mo-code)\n");
  }
});
