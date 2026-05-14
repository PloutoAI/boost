/**
 * Plain ANSI fallback for non-TTY stdout.
 * Honors `NO_COLOR` and `FORCE_COLOR=0` per common conventions.
 */
import chalk, { Chalk, type ChalkInstance } from "chalk";
import type { Finding } from "../types.ts";
import type { ModelUsage, Summary } from "../summary.ts";
import type {
  DailyPoint,
  McpServerUsage,
  ProjectUsage,
  ToolUsage,
} from "../activity.ts";
import { formatCompactNumber as fmt, shortPath as basename, truncate as trim } from "../format.ts";
import { dollarsFor, formatUsd, PRICING_SNAPSHOT_DATE } from "../pricing.ts";

export type PlainOptions = {
  color: boolean;
};

export type PlainObserved = {
  models: ModelUsage[];
  topTools: ToolUsage[];
  topMcpServers: McpServerUsage[];
  topProjects: ProjectUsage[];
  daily: DailyPoint[];
};

export function shouldUseColor(): boolean {
  if (process.env["NO_COLOR"]) return false;
  if (process.env["FORCE_COLOR"] === "0") return false;
  if (process.env["FORCE_COLOR"]) return true;
  return process.stdout.isTTY === true;
}

export function renderPlain(
  findings: Finding[],
  totalSavingsPct: number,
  summary: Summary,
  observed: PlainObserved,
  opts: PlainOptions,
): string {
  const c: ChalkInstance = opts.color ? chalk : new Chalk({ level: 0 });
  const lines: string[] = [];
  const hitPct = Math.round(summary.cache_hit_rate_last_7_days * 100);
  const costLabel = summary.cost_last_7_days_usd !== null
    ? `${formatUsd(summary.cost_last_7_days_usd)} `
    : "";
  lines.push(
    c.bold("boost") +
      ` — last 7 days: ${costLabel}${costLabel ? "· " : ""}${summary.uncached_tokens_last_7_days.toLocaleString()} uncached + ` +
      `${summary.cache_read_tokens_last_7_days.toLocaleString()} cache-read ` +
      c.dim(`(${hitPct}% hit) · ${summary.sessions_last_7_days} sessions`),
  );
  if (summary.cost_last_7_days_usd !== null) {
    lines.push(c.dim(`Pricing snapshot: ${PRICING_SNAPSHOT_DATE} (bundled, offline).`));
  }
  const pressure = summary.rate_limit_pressure;
  const drivers = pressure.drivers.length > 0 ? ` — ${pressure.drivers.join("; ")}` : "";
  lines.push(`Rate-limit pressure: ${pressureLevel(pressure.level, c)} ${c.dim(`(${pressure.score}/100)${drivers}`)}`);
  lines.push("");

  const clearWins = findings.filter((f) => f.category === "clear-wins");
  const tradeOffs = findings.filter((f) => f.category === "trade-offs");
  const hasFixable = findings.some((f) => f.fixes && f.fixes.length > 0);

  if (clearWins.length > 0) {
    lines.push(header("CLEAR WINS · fixable", totalSavingsPct, c));
    let i = 1;
    for (const f of clearWins) {
      lines.push(formatRow(i++, f, summary.uncached_cost_last_7_days_usd, c));
    }
    lines.push("");
  }

  if (tradeOffs.length > 0) {
    const tradeTotal = tradeOffs.reduce((s, f) => s + (f.estimatedPercentOfWeeklyUsage ?? 0), 0);
    lines.push(header("TRADE-OFFS · advisory", tradeTotal, c));
    let i = clearWins.length + 1;
    for (const f of tradeOffs) {
      lines.push(formatRow(i++, f, summary.uncached_cost_last_7_days_usd, c));
    }
    lines.push("");
  }

  if (findings.length === 0) {
    lines.push(c.dim("No findings to act on — see Observed below for what boost saw."));
    lines.push("");
  }

  // Observed panel: always rendered.
  pushObserved(lines, observed, c);

  if (hasFixable) {
    lines.push(`Run "boost fix <strategy-id>" on a ${c.bold("▶")} row, or "boost fix --all" for every clear-win.`);
    lines.push(`Advisory rows (${c.dim("·")}) are informational — no automated fix.`);
    lines.push(`Run "boost --json" for structured output.`);
  } else if (findings.length > 0) {
    lines.push(c.dim(`All findings are advisory (${c.dim("·")}) — no automated fix available.`));
    lines.push(c.dim(`Run "boost --json" for structured output.`));
  } else {
    lines.push(c.dim(`Run "boost --json" for the full structured output.`));
  }
  return lines.join("\n") + "\n";
}

function pressureLevel(level: Summary["rate_limit_pressure"]["level"], c: ChalkInstance): string {
  if (level === "high") return c.red("high");
  if (level === "medium") return c.yellow("medium");
  return c.green("low");
}

function pushObserved(lines: string[], obs: PlainObserved, c: ChalkInstance): void {
  lines.push(c.bold("OBSERVED · last 7 days"));
  if (obs.models.length > 0) {
    lines.push(c.dim("  Models"));
    for (const m of obs.models.slice(0, 4)) {
      const dollars = costForModel(m);
      const costCell = dollars !== null ? formatUsd(dollars).padStart(8) : "       —";
      lines.push(`    ${trim(m.model, 32).padEnd(34)} ${costCell} · ${fmt(m.uncachedTokens).padStart(7)} uncached · ${m.requests} reqs`);
    }
  }
  if (obs.topTools.length > 0) {
    lines.push(c.dim("  Top tools"));
    for (const t of obs.topTools.slice(0, 5)) {
      lines.push(`    ${trim(t.toolName, 32).padEnd(34)} ${t.count.toString().padStart(7)} calls`);
    }
  }
  if (obs.topMcpServers.length > 0) {
    lines.push(c.dim("  MCP servers (firing this week)"));
    for (const m of obs.topMcpServers.slice(0, 5)) {
      lines.push(
        `    ${trim(m.server, 32).padEnd(34)} ${m.toolCallCount.toString().padStart(7)} calls · ${m.distinctTools} distinct`,
      );
    }
  }
  if (obs.topProjects.length > 0) {
    lines.push(c.dim("  Top projects"));
    for (const p of obs.topProjects.slice(0, 4)) {
      const costCell = p.costUsd !== null ? formatUsd(p.costUsd).padStart(8) : "       —";
      lines.push(`    ${trim(basename(p.project), 32).padEnd(34)} ${costCell} · ${fmt(p.uncachedTokens).padStart(7)} uncached · ${p.requests} reqs`);
    }
  }
  if (obs.daily.length > 0) {
    const max = Math.max(1, ...obs.daily.map((d) => d.uncachedTokens));
    const blocks = " ▁▂▃▄▅▆▇█";
    const cells = obs.daily.map((d) => blocks[Math.round((d.uncachedTokens / max) * (blocks.length - 1))] ?? " ").join("");
    lines.push(c.dim("  Daily uncached"));
    lines.push(`    ${cells}  ${c.dim(`peak ${fmt(max)}`)}`);
  }
  lines.push("");
}

function header(name: string, pct: number, c: ChalkInstance): string {
  const right = `-${Math.round(pct)}% / week`;
  const padding = Math.max(2, 50 - name.length);
  return c.bold(`${name}${" ".repeat(padding)}${right}`);
}

function formatRow(idx: number, f: Finding, weeklyDollars: number | null, c: ChalkInstance): string {
  const pct = f.estimatedPercentOfWeeklyUsage;
  const pctText = pct === null ? "  —  " : `-${Math.round(pct).toString().padStart(2)}%`;
  const sevTag = colorSeverity(f.severity, c).padEnd(6);
  const dollarsText =
    pct !== null && weeklyDollars !== null && pct > 0
      ? ` · ${c.dim(`≈${formatUsd((pct / 100) * weeklyDollars)}/wk`)}`
      : "";
  // weeklyDollars passed in is the *uncached* bill — using total bill
  // would overstate because cache-read $ dominates total but doesn't
  // shrink at detector pct (detector pcts are against uncached tokens).
  const hasFix = !!(f.fixes && f.fixes.length > 0);
  const marker = hasFix ? c.bold("▶") : c.dim("·");
  return `  ${marker} ${idx}. ${f.title.padEnd(40).slice(0, 40)} ${sevTag} ${pctText}${dollarsText}`;
}

function colorSeverity(sev: Finding["severity"], c: ChalkInstance): string {
  switch (sev) {
    case "high":
      return c.red("high");
    case "medium":
      return c.yellow("med");
    case "low":
      return c.dim("low");
  }
}

function costForModel(m: ModelUsage): number | null {
  return dollarsFor(
    {
      input: m.inputTokens,
      output: m.outputTokens,
      cache_creation: m.cacheCreationTokens,
      cache_read: m.cacheReadTokens,
    },
    m.model,
  );
}
