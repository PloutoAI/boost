/**
 * Read CLAUDE.md from global, project, and (optional) memory locations.
 * Resolves `@import path/to/file.md` directives recursively (depth ≤ 5).
 *
 * Token estimate is `words × 1.33`, a coarse English proxy. Documented
 * approximate; not used for billing.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { claudeHome } from "../paths.ts";

export type ClaudeMdFile = {
  path: string;
  content: string;
  wordCount: number;
  estimatedTokens: number;
  imports: string[]; // resolved paths (depth-1 only); each appears as its own ClaudeMdFile too
};

/** Maximum recursion depth for `@import` resolution. Prevents infinite loops. */
const MAX_IMPORT_DEPTH = 5;
/** Maximum number of parent directories walked when looking for project CLAUDE.md. */
const MAX_PROJECT_ANCESTOR_WALK = 32;

/** Read every CLAUDE.md known about from a given project cwd. */
export function readClaudeMdFiles(cwd: string = process.cwd()): ClaudeMdFile[] {
  const out: ClaudeMdFile[] = [];
  const visited = new Set<string>();

  const globalPath = path.join(claudeHome(), "CLAUDE.md");
  collect(globalPath, 0, out, visited);

  // Project: walk up from cwd looking for `.claude/CLAUDE.md`.
  let dir = path.resolve(cwd);
  for (let i = 0; i < MAX_PROJECT_ANCESTOR_WALK; i++) {
    const projectPath = path.join(dir, ".claude", "CLAUDE.md");
    collect(projectPath, 0, out, visited);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const memoryPath = path.join(claudeHome(), "MEMORY.md");
  collect(memoryPath, 0, out, visited);

  return out;
}

function collect(filePath: string, depth: number, out: ClaudeMdFile[], visited: Set<string>): void {
  if (depth > MAX_IMPORT_DEPTH) return;
  let canon: string;
  try {
    canon = fs.realpathSync(filePath);
  } catch {
    return;
  }
  if (visited.has(canon)) return;
  visited.add(canon);

  let content: string;
  try {
    content = fs.readFileSync(canon, "utf8");
  } catch {
    return;
  }
  const words = countWords(content);
  const imports = extractImports(content, path.dirname(canon));

  out.push({
    path: canon,
    content,
    wordCount: words,
    estimatedTokens: Math.round(words * 1.33),
    imports,
  });

  for (const imp of imports) {
    collect(imp, depth + 1, out, visited);
  }
}

function countWords(s: string): number {
  const matches = s.match(/\S+/g);
  return matches ? matches.length : 0;
}

function extractImports(content: string, baseDir: string): string[] {
  const out: string[] = [];
  // Pattern: `@import path/to/file.md` at start of line.
  const re = /^@import\s+(\S+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const target = m[1];
    if (!target) continue;
    const resolved = path.resolve(baseDir, target);
    out.push(resolved);
  }
  return out;
}
