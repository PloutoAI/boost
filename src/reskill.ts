import * as fs from "node:fs";
import * as path from "node:path";
import type { DetectorContext } from "./strategy.ts";
import { boostHome } from "./paths.ts";
import { topProjects, topTools, type ProjectUsage, type ToolUsage } from "./activity.ts";
import { formatCompactNumber as fmt } from "./format.ts";
import { formatUsd } from "./pricing.ts";

export type ReskillOpportunity = {
  name: string;
  kind: "project-skill" | "skill-trim" | "skill-cleanup";
  title: string;
  why: string;
  next: string;
  project?: ProjectUsage;
  skills?: string[];
};

export type InstalledSkillSummary = {
  name: string;
  frontmatter_tokens: number;
  body_tokens: number;
};

export type ReskillReport = {
  generated_at: string;
  skill_count: number;
  frontmatter_tokens: number;
  body_tokens: number;
  installed_skills: InstalledSkillSummary[];
  opportunities: ReskillOpportunity[];
};

export type DraftResult = {
  name: string;
  path: string;
  existed: boolean;
  message: string;
};

export function buildReskillReport(ctx: DetectorContext): ReskillReport {
  const opportunities: ReskillOpportunity[] = [];
  const skills = ctx.config.skills;
  const frontmatterTokens = skills.reduce((n, s) => n + s.frontmatterTokens, 0);

  const heavy = skills.filter((s) => s.frontmatterTokens >= 180).sort((a, b) => b.frontmatterTokens - a.frontmatterTokens);
  if (heavy.length > 0) {
    opportunities.push({
      name: "trim-skill-triggers",
      kind: "skill-trim",
      title: `Trim ${heavy.length} heavy skill trigger${heavy.length === 1 ? "" : "s"}`,
      why: `Skill frontmatter is loaded for trigger matching. Heavy descriptions add baseline context even before the skill body is useful.`,
      next: `Tighten descriptions for: ${heavy.slice(0, 4).map((s) => `${s.name} (${s.frontmatterTokens}t)`).join(", ")}.`,
      skills: heavy.map((s) => s.name),
    });
  }

  const projects = topProjects(ctx.events.db, 14, 5).filter((p) => p.requests >= 8 || p.uncachedTokens >= 1_000_000);
  const existingSkillNames = new Set(skills.map((s) => s.name));
  for (const project of projects) {
    const name = uniqueName(slugProject(project.project), existingSkillNames);
    if (existingSkillNames.has(name)) continue;
    opportunities.push({
      name,
      kind: "project-skill",
      title: `Create a project skill for ${shortProject(project.project)}`,
      why: `${formatUsd(project.costUsd)} of spend in this project over ${project.sessions} session${project.sessions === 1 ? "" : "s"} (${project.requests} requests, ${fmt(project.uncachedTokens)} uncached tokens) — and no skill encoding what Claude keeps rediscovering. A project skill stops the assistant relearning your commands, entrypoints, and repo conventions every session.`,
      next: `Run "boost reskill ${name}" to draft a local skill template.`,
      project,
    });
  }

  if (skills.length === 0 && projects.length > 0) {
    opportunities.unshift({
      name: "first-project-skill",
      kind: "project-skill",
      title: "Create your first project skill",
      why: "You have Claude Code project activity but no installed skills. Skills are the reusable layer for repo maps, commands, and task workflows.",
      next: `Start with "boost reskill ${uniqueName(slugProject(projects[0]!.project), existingSkillNames)}".`,
      project: projects[0],
    });
  }

  return {
    generated_at: new Date().toISOString(),
    skill_count: skills.length,
    frontmatter_tokens: frontmatterTokens,
    body_tokens: skills.reduce((n, s) => n + s.bodyTokens, 0),
    installed_skills: skills.map((s) => ({
      name: s.name,
      frontmatter_tokens: s.frontmatterTokens,
      body_tokens: s.bodyTokens,
    })),
    opportunities: opportunities.slice(0, 8),
  };
}

export function renderReskillReport(report: ReskillReport): string {
  const lines: string[] = [];
  lines.push("boost reskill");
  lines.push(
    `Installed skills: ${report.skill_count} · ${report.frontmatter_tokens.toLocaleString()} frontmatter + ${report.body_tokens.toLocaleString()} body tokens total`,
  );
  if (report.installed_skills.length > 0) {
    lines.push("");
    const sorted = [...report.installed_skills].sort(
      (a, b) => b.frontmatter_tokens + b.body_tokens - (a.frontmatter_tokens + a.body_tokens),
    );
    for (const s of sorted) {
      lines.push(
        `  ${s.name.padEnd(34)} ${String(s.frontmatter_tokens).padStart(4)} frontmatter · ${String(s.body_tokens).padStart(5)} body`,
      );
    }
  }
  lines.push("");
  if (report.opportunities.length === 0) {
    lines.push("No skill opportunities found yet.");
    lines.push("Run more Claude Code sessions, then re-run `boost reskill`.");
    return lines.join("\n") + "\n";
  }
  lines.push("Skill opportunities");
  report.opportunities.forEach((op, i) => {
    lines.push(`${i + 1}. ${op.title}`);
    lines.push(`   ${op.why}`);
    lines.push(`   ${op.next}`);
    lines.push("");
  });
  return lines.join("\n");
}

export function createSkillDraft(nameArg: string, ctx: DetectorContext): DraftResult {
  const report = buildReskillReport(ctx);
  const name = slug(nameArg);
  const opportunity = report.opportunities.find((op) => op.name === name);
  const project = opportunity?.project ?? topProjects(ctx.events.db, 14, 1)[0];
  const tools = topTools(ctx.events.db, 14, 5);

  const dir = path.join(boostHome(), "drafts", "skills", name);
  const file = path.join(dir, "SKILL.md");
  if (fs.existsSync(file)) {
    return { name, path: file, existed: true, message: `draft already exists: ${file}` };
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, draftContent(name, project, tools), { mode: 0o600 });
  return { name, path: file, existed: false, message: `created draft: ${file}` };
}

function draftContent(name: string, project: ProjectUsage | undefined, tools: ToolUsage[]): string {
  const projectLine = project ? ` for ${shortProject(project.project)}` : "";
  const toolList = tools.length > 0 ? tools.map((t) => `- ${t.toolName}${t.mcpServer ? ` (${t.mcpServer})` : ""}`).join("\n") : "- Bash\n- Read\n- Edit";
  return `---
name: ${name}
description: Use this skill when working${projectLine}, especially when the assistant needs repo context, common commands, tests, or implementation conventions.
---

# ${name}

## When to use

Use this skill for recurring work${projectLine}. Keep this focused on stable context that prevents the assistant from rediscovering the same setup every session.

## Project map

- Main entrypoints:
- Important directories:
- Configuration files:

## Common commands

- Install dependencies:
- Typecheck:
- Test:
- Build:

## Workflow

1. Inspect the relevant files first.
2. Make the smallest safe change.
3. Run the narrowest useful verification command.
4. Summarize what changed and any follow-ups.

## Tools often used here

${toolList}

## Notes

- Add project-specific auth, environment, migration, or deployment notes here.
- Remove anything that is not stable enough to reuse.
`;
}

function uniqueName(base: string, existing: Set<string>): string {
  if (!existing.has(base)) return base;
  for (let i = 2; i < 20; i++) {
    const candidate = `${base}-${i}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

function slugProject(project: string): string {
  const parts = project.split(path.sep).filter(Boolean);
  return slug(parts.at(-1) ?? "project-skill");
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "project-skill";
}

function shortProject(project: string): string {
  const parts = project.split(path.sep).filter(Boolean);
  return parts.slice(-2).join(path.sep) || project;
}

