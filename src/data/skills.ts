/**
 * Enumerate skills installed under `${CLAUDE_CONFIG_DIR}/skills/`.
 * Each skill is a directory containing a `SKILL.md` with YAML frontmatter.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { claudeHome } from "../paths.ts";

export type Skill = {
  name: string;
  /** Canonical absolute path to the skill directory. */
  path: string;
  /** Path of `SKILL.md` (canonical). */
  skillMdPath: string;
  description: string | null;
  frontmatterTokens: number;
  bodyTokens: number;
  /** Most-recent mtime of any file in the skill dir; used for grace-period check. */
  mtimeMs: number;
};

export function enumerateSkills(): Skill[] {
  const dir = path.join(claudeHome(), "skills");
  if (!fs.existsSync(dir)) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Skill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = path.join(dir, entry.name);
    const skillMd = path.join(skillDir, "SKILL.md");
    if (!fs.existsSync(skillMd)) continue;
    let canonDir: string;
    let canonMd: string;
    try {
      canonDir = fs.realpathSync(skillDir);
      canonMd = fs.realpathSync(skillMd);
    } catch {
      continue;
    }
    let raw: string;
    try {
      raw = fs.readFileSync(canonMd, "utf8");
    } catch {
      continue;
    }
    const { frontmatter, body, description } = parseFrontmatter(raw);
    const frontmatterTokens = Math.round(countWords(frontmatter) * 1.33);
    const bodyTokens = Math.round(countWords(body) * 1.33);
    out.push({
      name: entry.name,
      path: canonDir,
      skillMdPath: canonMd,
      description,
      frontmatterTokens,
      bodyTokens,
      mtimeMs: latestMtime(canonDir),
    });
  }
  return out;
}

function parseFrontmatter(raw: string): { frontmatter: string; body: string; description: string | null } {
  // Frontmatter is `---\n...\n---\n` at the very top.
  if (!raw.startsWith("---")) return { frontmatter: "", body: raw, description: null };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: "", body: raw, description: null };
  const frontmatter = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).replace(/^\n/, "");
  // Cheap YAML scan for `description:` — we only need that field.
  let description: string | null = null;
  for (const line of frontmatter.split(/\r?\n/)) {
    const m = line.match(/^description\s*:\s*(.+)$/);
    if (m && m[1]) {
      let v = m[1].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      description = v;
      break;
    }
  }
  return { frontmatter, body, description };
}

function countWords(s: string): number {
  const m = s.match(/\S+/g);
  return m ? m.length : 0;
}

function latestMtime(dir: string): number {
  let latest = 0;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      try {
        const st = fs.lstatSync(full);
        if (st.isSymbolicLink()) continue;
        if (st.mtimeMs > latest) latest = st.mtimeMs;
        if (st.isDirectory()) stack.push(full);
      } catch {
        // ignore
      }
    }
  }
  return latest;
}
