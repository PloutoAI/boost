#!/usr/bin/env node
/**
 * boost launcher. The CLI runs under Bun — `bun:sqlite` (event log) and
 * `bun:ffi` (opentui's native renderer) are both Bun-only. The launcher
 * works under Node by detecting Bun and re-execing the bundle through it,
 * or printing a clear "install Bun" hint when it isn't present.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const sourceEntry = path.resolve(repoRoot, "src", "cli.ts");
const bundleEntry = path.resolve(repoRoot, "dist", "cli.js");

// Source checkouts should run live TypeScript. Installed packages may publish
// src for public subpath exports, so they must prefer the built bundle.
const isSourceCheckout = fs.existsSync(path.join(repoRoot, ".git"));
const target = isSourceCheckout && fs.existsSync(sourceEntry) ? sourceEntry : bundleEntry;

if (!fs.existsSync(target)) {
  process.stderr.write(
    `boost: entry not found at ${target}\n` +
      `Reinstall the package or run \`bun run build\` from the repo root.\n`,
  );
  process.exit(127);
}

const isBun = typeof globalThis.Bun !== "undefined";
if (isBun && target.endsWith(".js")) {
  // Already running under Bun and we have a bundle — import inline.
  await import(target);
} else {
  const probe = spawnSync("bun", ["--version"], { stdio: "ignore" });
  if (probe.status !== 0) {
    process.stderr.write(
      `boost requires Bun (https://bun.sh) to run.\n\n` +
        `Install with:\n` +
        `  curl -fsSL https://bun.sh/install | bash\n\n` +
        `Then re-run this command. (boost uses bun:sqlite + bun:ffi via opentui; the Node runtime is not supported.)\n`,
    );
    process.exit(127);
  }
  const r = spawnSync("bun", [target, ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}
