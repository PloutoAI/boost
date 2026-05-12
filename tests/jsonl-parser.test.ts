import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseJsonl } from "../src/data/jsonl-parser.ts";

function withTempFile(content: Buffer | string, fn: (p: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boost-jsonl-"));
  const p = path.join(dir, "session.jsonl");
  fs.writeFileSync(p, content);
  try {
    fn(p);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("parses well-formed JSONL", () => {
  const lines = [
    JSON.stringify({ uuid: "1", timestamp: "2026-01-01T00:00:00Z" }),
    JSON.stringify({ uuid: "2", timestamp: "2026-01-01T00:00:01Z" }),
  ].join("\n") + "\n";
  withTempFile(lines, (p) => {
    const r = parseJsonl(p, 0);
    expect(r.messages.length).toBe(2);
    expect(r.endOffset).toBe(lines.length);
  });
});

test("resuming from an offset returns no duplicates", () => {
  const lines = [
    JSON.stringify({ uuid: "a", timestamp: "2026-01-01T00:00:00Z" }),
    JSON.stringify({ uuid: "b", timestamp: "2026-01-01T00:00:01Z" }),
  ].join("\n") + "\n";
  withTempFile(lines, (p) => {
    const r1 = parseJsonl(p, 0);
    expect(r1.messages.length).toBe(2);
    const r2 = parseJsonl(p, r1.endOffset);
    expect(r2.messages.length).toBe(0);
  });
});

test("trailing partial line is ignored; offset is before partial", () => {
  const goodLine = JSON.stringify({ uuid: "1", timestamp: "2026-01-01T00:00:00Z" }) + "\n";
  const partial = "{\"uuid\":\"2\""; // no newline, no closing brace
  const buf = goodLine + partial;
  withTempFile(buf, (p) => {
    const r = parseJsonl(p, 0);
    expect(r.messages.length).toBe(1);
    expect(r.endOffset).toBe(goodLine.length);
  });
});

test("malformed JSON line is skipped with warning", () => {
  const lines = `not json\n${JSON.stringify({ uuid: "ok", timestamp: "2026-01-01T00:00:00Z" })}\n`;
  withTempFile(lines, (p) => {
    const r = parseJsonl(p, 0);
    expect(r.messages.length).toBe(1);
    expect(r.warnings.length).toBe(1);
  });
});

test("oversized line is skipped without crashing", () => {
  const huge = "x".repeat(2_000_000); // > 1MB
  const buf = `{"a":"${huge}"}\n${JSON.stringify({ uuid: "ok", timestamp: "2026-01-01T00:00:00Z" })}\n`;
  withTempFile(buf, (p) => {
    const r = parseJsonl(p, 0);
    expect(r.messages.length).toBe(1);
    expect(r.warnings.some((w) => w.includes("exceeds 1MB"))).toBeTrue();
  });
});
