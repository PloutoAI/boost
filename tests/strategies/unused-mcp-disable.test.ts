import { test, expect, beforeEach, afterEach } from "bun:test";
import * as path from "node:path";
import strategy from "../../src/strategies/unused-mcp-disable.ts";
import { makeTempHome, type TempLoopHome } from "../helpers/temp-loop-home.ts";
import {
  makeDetectorContext,
  fakeSettings,
  fakeMcpServers,
  seedApiRequest,
  seedMcpToolUse,
  singleFinding,
  type FakeContext,
} from "../helpers/detector-context.ts";

let h: TempLoopHome;
let f: FakeContext | null = null;

beforeEach(() => {
  h = makeTempHome();
});
afterEach(() => {
  if (f) f.cleanup();
  f = null;
  h.cleanup();
});

const DAY = 24 * 60 * 60 * 1000;

test("returns null in cold start (< 14 days of data)", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 5,
    settings: fakeSettings({
      filePath: path.join(h.claudeHome, "settings.json"),
      servers: [{ name: "github-mcp" }],
    }),
  });
  expect(strategy.detect(f.ctx)).toBeNull();
});

test("returns null when no MCP servers configured", () => {
  f = makeDetectorContext({ settings: null });
  expect(strategy.detect(f.ctx)).toBeNull();
});

test("flags servers with no tool_use events in window", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    settings: fakeSettings({
      filePath: path.join(h.claudeHome, "settings.json"),
      servers: [{ name: "github-mcp" }, { name: "postgres-mcp" }],
    }),
    seed: (db) => {
      seedApiRequest(db, { eventId: "e1", timestamp: yesterdayIso() });
    },
  });
  const finding = singleFinding(strategy.detect(f.ctx));
  expect(finding.affectedItems.sort()).toEqual(["github-mcp", "postgres-mcp"]);
  // Two servers → high severity.
  expect(finding.severity).toBe("medium");
});

test("severity is high when 3+ servers are unused", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    settings: fakeSettings({
      filePath: path.join(h.claudeHome, "settings.json"),
      servers: [{ name: "a" }, { name: "b" }, { name: "c" }],
    }),
    seed: (db) => seedApiRequest(db, { eventId: "e1", timestamp: yesterdayIso() }),
  });
  const finding = singleFinding(strategy.detect(f.ctx));
  expect(finding.severity).toBe("high");
});

test("excludes servers that fired tools within the window", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    settings: fakeSettings({
      filePath: path.join(h.claudeHome, "settings.json"),
      servers: [{ name: "github-mcp" }, { name: "postgres-mcp" }],
    }),
    seed: (db) => {
      seedApiRequest(db, { eventId: "e1", timestamp: yesterdayIso() });
      seedMcpToolUse(db, {
        eventId: "tu1",
        timestamp: yesterdayIso(),
        serverName: "github-mcp",
      });
    },
  });
  const finding = singleFinding(strategy.detect(f.ctx));
  expect(finding.affectedItems).toEqual(["postgres-mcp"]);
});

test("excludes already-disabled servers", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    settings: fakeSettings({
      filePath: path.join(h.claudeHome, "settings.json"),
      servers: [{ name: "active" }, { name: "already-off", disabled: true }],
    }),
    seed: (db) => seedApiRequest(db, { eventId: "e1", timestamp: yesterdayIso() }),
  });
  const finding = singleFinding(strategy.detect(f.ctx));
  expect(finding.affectedItems).toEqual(["active"]);
});

test("normalizes server names (case + underscore/hyphen drift)", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    settings: fakeSettings({
      filePath: path.join(h.claudeHome, "settings.json"),
      servers: [{ name: "Foo_Bar" }],
    }),
    seed: (db) => {
      seedApiRequest(db, { eventId: "e1", timestamp: yesterdayIso() });
      seedMcpToolUse(db, { eventId: "tu1", timestamp: yesterdayIso(), serverName: "foo-bar" });
    },
  });
  expect(strategy.detect(f.ctx)).toBeNull();
});

test("emits one fix per affected item (fixes is non-empty array)", () => {
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    settings: fakeSettings({
      filePath: path.join(h.claudeHome, "settings.json"),
      servers: [{ name: "a" }, { name: "b" }, { name: "c" }],
    }),
    seed: (db) => seedApiRequest(db, { eventId: "e1", timestamp: yesterdayIso() }),
  });
  const finding = singleFinding(strategy.detect(f.ctx));
  expect(finding.fixes!.length).toBe(3);
  for (const fix of finding.fixes!) {
    expect(fix.kind).toBe("modify-settings-key");
  }
});

test("savings percentage is clamped to 99.9", () => {
  // Tiny weekly token budget + many servers → naive math would exceed 100%.
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    settings: fakeSettings({
      filePath: path.join(h.claudeHome, "settings.json"),
      servers: Array.from({ length: 12 }, (_, i) => ({ name: `s${i}` })),
    }),
    seed: (db) => {
      // Single tiny request — total tokens = 5.
      seedApiRequest(db, {
        eventId: "e1",
        timestamp: yesterdayIso(),
        inputTokens: 3,
        outputTokens: 2,
      });
    },
  });
  const finding = singleFinding(strategy.detect(f.ctx));
  expect(finding.estimatedPercentOfWeeklyUsage).not.toBeNull();
  expect(finding.estimatedPercentOfWeeklyUsage!).toBeLessThanOrEqual(99.9);
});

test("project .mcp.json servers are surfaced in evidence but not auto-fixed (v0.1)", () => {
  // User settings has nothing; the unused server lives in a project .mcp.json.
  const projectMcpPath = path.join(h.claudeHome, "..", "myproject", ".mcp.json");
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    settings: null,
    mcpServers: fakeMcpServers([
      { name: "ghost-mcp", source: "project-mcp-json", sourcePath: projectMcpPath },
    ]),
    seed: (db) => seedApiRequest(db, { eventId: "e1", timestamp: yesterdayIso() }),
  });
  const finding = strategy.detect(f.ctx);
  // No fixes (we don't write project .mcp.json in v0.1) → returns null even though
  // the server is technically unused.
  expect(finding).toBeNull();
});

test("plugin-defined MCP servers do NOT cause user-settings fixes to fire spuriously", () => {
  const userSettings = fakeSettings({
    filePath: path.join(h.claudeHome, "settings.json"),
    servers: [{ name: "user-server" }],
  });
  const pluginMcpPath = path.join(h.claudeHome, "plugins", "demo", ".mcp.json");
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    settings: userSettings,
    mcpServers: [
      ...fakeMcpServers([
        { name: "user-server", source: "user-settings", sourcePath: userSettings.path },
        { name: "plugin-server", source: "plugin-mcp-json", sourcePath: pluginMcpPath },
      ]),
    ],
    seed: (db) => seedApiRequest(db, { eventId: "e1", timestamp: yesterdayIso() }),
  });
  const finding = singleFinding(strategy.detect(f.ctx));
  // Only the user-settings server is in fixes, even though both are unused.
  expect(finding.affectedItems).toEqual(["user-server"]);
  for (const fix of finding.fixes!) {
    expect(fix.kind).toBe("modify-settings-key");
    if (fix.kind === "modify-settings-key") {
      expect(fix.payload.filePath).toBe(userSettings.path);
    }
  }
});

test("freshly-installed server (source file < 7 days old) gets a per-server grace period", () => {
  // Settings file with two servers — both never fired. One source file is fresh.
  const settingsPath = path.join(h.claudeHome, "settings.json");
  // Build the settings record but back-date its mtime via fakeSettings (which sets it to 8 days old).
  const old = fakeSettings({
    filePath: settingsPath,
    servers: [{ name: "old-server" }, { name: "fresh-server" }],
  });
  // Now make the file freshly modified — touching the *settings.json* mtime.
  // Both servers share that path, so both should be skipped per-server when fresh.
  const oneHourAgo = (Date.now() - 60 * 60 * 1000) / 1000;
  require("node:fs").utimesSync(settingsPath, oneHourAgo, oneHourAgo);
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    settings: old,
    seed: (db) => seedApiRequest(db, { eventId: "e1", timestamp: yesterdayIso() }),
  });
  // Both share a fresh source file AND have no events ever → both skipped → null.
  expect(strategy.detect(f.ctx)).toBeNull();
});

test("freshly-installed grace does NOT shield a server that has fired before", () => {
  // The settings.json was just edited, but our event log shows this server fired in the past.
  // We should still flag it as unused (recent activity is the real signal, not file mtime).
  const settingsPath = path.join(h.claudeHome, "settings.json");
  const old = fakeSettings({
    filePath: settingsPath,
    servers: [{ name: "previously-active" }],
  });
  const oneHourAgo = (Date.now() - 60 * 60 * 1000) / 1000;
  require("node:fs").utimesSync(settingsPath, oneHourAgo, oneHourAgo);
  f = makeDetectorContext({
    daysOfDataAvailable: 30,
    settings: old,
    seed: (db) => {
      seedApiRequest(db, { eventId: "e1", timestamp: yesterdayIso() });
      // Fired 90 days ago — past the 60-day window but still in the "ever fired" set.
      const ninetyDaysAgo = new Date(Date.now() - 90 * DAY).toISOString();
      seedMcpToolUse(db, {
        eventId: "tu1",
        timestamp: ninetyDaysAgo,
        serverName: "previously-active",
      });
    },
  });
  const finding = singleFinding(strategy.detect(f.ctx));
  expect(finding.affectedItems).toEqual(["previously-active"]);
});

function yesterdayIso(): string {
  return new Date(Date.now() - 1 * DAY).toISOString();
}
