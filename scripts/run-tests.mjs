import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

rmSync(".test-build", { recursive: true, force: true });
const tsc = process.platform === "win32" ? "tsc.cmd" : "tsc";
const compile = spawnSync(tsc, ["-p", "tsconfig.test.json"], { stdio: "inherit" });
if (compile.error) throw compile.error;
if (compile.status !== 0) process.exit(compile.status ?? 1);

writeFileSync(".test-build/package.json", '{"type":"commonjs"}\n');
const tests = readdirSync("tests")
  .filter((name) => name.endsWith(".test.cjs"))
  .sort()
  .map((name) => `tests/${name}`);
if (tests.length === 0) throw new Error("no tests found");

const run = spawnSync(process.execPath, ["--test", ...tests], { stdio: "inherit" });
if (run.error) throw run.error;
process.exit(run.status ?? 1);
