import { test, expect, beforeEach, afterEach } from "bun:test";
import { LoopDatabase } from "../src/db.ts";
import {
  topTools,
  topMcpServers,
  topProjects,
  topSessions,
  dailySeries,
} from "../src/activity.ts";
import { makeTempHome, type TempLoopHome } from "./helpers/temp-loop-home.ts";
import {
  seedApiRequest,
  seedMcpToolUse,
} from "./helpers/detector-context.ts";

let h: TempLoopHome;
beforeEach(() => {
  h = makeTempHome();
});
afterEach(() => h.cleanup());

const yesterdayIso = () => new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

function seedToolUse(
  db: import("bun:sqlite").Database,
  args: { eventId: string; timestamp: string; toolName: string },
): void {
  db.prepare(
    `INSERT INTO events (event_id, schema_version, timestamp_iso, user_id, machine_id, provider, session_id, message_id, event_type, payload_json)
     VALUES (?, 1, ?, 'u', 'm', 'claude_code', 's1', NULL, 'tool_use', ?)`,
  ).run(
    args.eventId,
    args.timestamp,
    JSON.stringify({
      tool_name: args.toolName,
      tool_use_id: args.eventId,
      mcp_server_name: null,
      parent_event_id: "p",
    }),
  );
}

test("topTools ranks by call count and excludes empty windows", () => {
  const handle = LoopDatabase.open();
  const db = handle.db;
  for (let i = 0; i < 10; i++) seedToolUse(db, { eventId: `bash${i}`, timestamp: yesterdayIso(), toolName: "Bash" });
  for (let i = 0; i < 3; i++) seedToolUse(db, { eventId: `read${i}`, timestamp: yesterdayIso(), toolName: "Read" });
  const result = topTools(db, 7, 5);
  expect(result.length).toBe(2);
  expect(result[0]!.toolName).toBe("Bash");
  expect(result[0]!.count).toBe(10);
  expect(result[1]!.toolName).toBe("Read");
  handle.close();
});

test("topMcpServers returns distinct-tool counts", () => {
  const handle = LoopDatabase.open();
  const db = handle.db;
  seedMcpToolUse(db, { eventId: "g1", timestamp: yesterdayIso(), serverName: "github-mcp", toolName: "mcp__github-mcp__list_issues" });
  seedMcpToolUse(db, { eventId: "g2", timestamp: yesterdayIso(), serverName: "github-mcp", toolName: "mcp__github-mcp__list_issues" });
  seedMcpToolUse(db, { eventId: "g3", timestamp: yesterdayIso(), serverName: "github-mcp", toolName: "mcp__github-mcp__create_pr" });
  const result = topMcpServers(db, 7, 5);
  expect(result.length).toBe(1);
  expect(result[0]!.server).toBe("github-mcp");
  expect(result[0]!.toolCallCount).toBe(3);
  expect(result[0]!.distinctTools).toBe(2);
  handle.close();
});

test("topProjects sums uncached tokens and counts sessions", () => {
  const handle = LoopDatabase.open();
  const db = handle.db;
  // Two sessions in /repo-a, one in /repo-b.
  seedApiRequest(db, {
    eventId: "a1",
    sessionId: "sa1",
    timestamp: yesterdayIso(),
    inputTokens: 1000,
    outputTokens: 500,
    cacheCreationTokens: 0,
  });
  // Override cwd by directly inserting a custom payload for /repo-a.
  db.prepare(
    `UPDATE events SET payload_json = json_set(payload_json, '$.cwd', '/repo-a') WHERE event_id = 'a1'`,
  ).run();
  seedApiRequest(db, {
    eventId: "a2",
    sessionId: "sa2",
    timestamp: yesterdayIso(),
    inputTokens: 2000,
    outputTokens: 0,
    cacheCreationTokens: 0,
  });
  db.prepare(
    `UPDATE events SET payload_json = json_set(payload_json, '$.cwd', '/repo-a') WHERE event_id = 'a2'`,
  ).run();
  seedApiRequest(db, {
    eventId: "b1",
    sessionId: "sb1",
    timestamp: yesterdayIso(),
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationTokens: 0,
  });
  db.prepare(
    `UPDATE events SET payload_json = json_set(payload_json, '$.cwd', '/repo-b') WHERE event_id = 'b1'`,
  ).run();

  const result = topProjects(db, 7, 5);
  expect(result.length).toBe(2);
  expect(result[0]!.project).toBe("/repo-a");
  expect(result[0]!.uncachedTokens).toBe(3500);
  expect(result[0]!.sessions).toBe(2);
  expect(result[1]!.project).toBe("/repo-b");
  handle.close();
});

test("topSessions returns sessions ranked by uncached tokens", () => {
  const handle = LoopDatabase.open();
  const db = handle.db;
  seedApiRequest(db, { eventId: "a", sessionId: "big", timestamp: yesterdayIso(), inputTokens: 5000, outputTokens: 5000 });
  seedApiRequest(db, { eventId: "b", sessionId: "small", timestamp: yesterdayIso(), inputTokens: 100, outputTokens: 50 });
  const result = topSessions(db, 7, 3);
  expect(result.length).toBe(2);
  expect(result[0]!.sessionId).toBe("big");
  expect(result[0]!.uncachedTokens).toBeGreaterThan(result[1]!.uncachedTokens);
  handle.close();
});

test("dailySeries buckets by UTC date and returns oldest-first", () => {
  const handle = LoopDatabase.open();
  const db = handle.db;
  const today = new Date().toISOString();
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  seedApiRequest(db, { eventId: "t1", timestamp: today, inputTokens: 100, outputTokens: 0 });
  seedApiRequest(db, { eventId: "t2", timestamp: today, inputTokens: 200, outputTokens: 0 });
  seedApiRequest(db, { eventId: "old", timestamp: twoDaysAgo, inputTokens: 50, outputTokens: 0 });
  const result = dailySeries(db, 7);
  expect(result.length).toBeGreaterThanOrEqual(2);
  // Oldest first.
  expect(result[0]!.date < result[result.length - 1]!.date).toBeTrue();
  // Today's bucket should sum 300 input.
  const todayDate = today.slice(0, 10);
  const todayPoint = result.find((p) => p.date === todayDate);
  expect(todayPoint?.uncachedTokens).toBe(300);
  handle.close();
});

test("queries return empty arrays when no matching events", () => {
  const handle = LoopDatabase.open();
  expect(topTools(handle.db, 7).length).toBe(0);
  expect(topMcpServers(handle.db, 7).length).toBe(0);
  expect(topProjects(handle.db, 7).length).toBe(0);
  expect(topSessions(handle.db, 7).length).toBe(0);
  expect(dailySeries(handle.db, 7).length).toBe(0);
  handle.close();
});
