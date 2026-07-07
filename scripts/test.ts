// Run every scripts/test-*.ts unit suite and aggregate the result. A suite
// fails if it exits non-zero OR prints a ❌ line (not all suites call
// process.exit on failure), so this stays honest for `pnpm test` / CI.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const dir = "scripts";
const suites = readdirSync(dir)
  .filter((f) => /^test-.*\.ts$/.test(f))
  .sort();

let failed = 0;
for (const suite of suites) {
  const r = spawnSync("npx", ["tsx", join(dir, suite)], { encoding: "utf8" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const ok = r.status === 0 && !out.includes("❌");
  console.log(`${ok ? "ok  " : "FAIL"} ${suite}`);
  if (!ok) {
    failed++;
    process.stdout.write(out.replace(/^/gm, "    "));
  }
}

if (failed) {
  console.error(`\n${failed}/${suites.length} suite(s) failed`);
  process.exit(1);
}
console.log(`\nall ${suites.length} suites passed`);
