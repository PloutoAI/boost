import { test, expect, beforeEach, afterEach } from "bun:test";
import { LoopDatabase } from "../src/db.ts";
import { makeTempHome, type TempLoopHome } from "./helpers/temp-loop-home.ts";

let h: TempLoopHome;
beforeEach(() => {
  h = makeTempHome();
});
afterEach(() => h.cleanup());

test("opens fresh DB and applies initial migration", () => {
  const handle = LoopDatabase.open();
  const tables = handle.db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all();
  const names = tables.map((t) => t.name);
  expect(names).toContain("events");
  expect(names).toContain("operations");
  expect(names).toContain("dismissed");
  handle.close();
});

test("re-opening doesn't fail and is idempotent", () => {
  LoopDatabase.open().close();
  const handle2 = LoopDatabase.open();
  // Insert a row, close, re-open, verify row still there.
  handle2.db
    .prepare(
      `INSERT INTO events (event_id, schema_version, timestamp_iso, user_id, machine_id, provider, event_type, payload_json)
       VALUES (?, 1, ?, 'u', 'm', 'claude_code', 'api_request', '{}')`,
    )
    .run("e1", "2026-01-01T00:00:00Z");
  handle2.close();

  const handle3 = LoopDatabase.open();
  const r = handle3.db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM events").get();
  expect(r?.c).toBe(1);
  handle3.close();
});
