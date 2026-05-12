/** Enumerate top-level plugin directories under `${CLAUDE_CONFIG_DIR}/plugins/`. */
import * as fs from "node:fs";
import * as path from "node:path";
import { claudeHome } from "../paths.ts";

export type Plugin = {
  name: string;
  path: string; // canonical
};

export function enumeratePlugins(): Plugin[] {
  const dir = path.join(claudeHome(), "plugins");
  if (!fs.existsSync(dir)) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Plugin[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = path.join(dir, e.name);
    let canon: string;
    try {
      canon = fs.realpathSync(full);
    } catch {
      continue;
    }
    out.push({ name: e.name, path: canon });
  }
  return out;
}
