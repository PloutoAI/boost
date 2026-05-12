/**
 * Streaming JSONL parser. Don't load the file whole; sessions get large.
 *
 * Limits (threat model §C3.3):
 * - Per-line max: 1 MB. Lines exceeding skip with a warning.
 * - Total file scan max: 500 MB. Beyond, parsing stops with a warning.
 *
 * Returns an async iterator of `{ message, lineEndOffset }` and the byte offset
 * where parsing stopped (so callers can persist resume state).
 */
import * as fs from "node:fs";

const PER_LINE_MAX = 1_048_576; // 1 MB
const TOTAL_SCAN_MAX = 500 * 1_048_576; // 500 MB

export type ParsedMessage = {
  /** The raw JSON object as parsed; consumer decides validity. */
  raw: unknown;
  /** Byte offset *after* the terminating newline of this line. */
  lineEndOffset: number;
};

export type ParseResult = {
  messages: ParsedMessage[];
  /** Byte offset where parsing stopped (exclusive). Persist as resume cursor. */
  endOffset: number;
  warnings: string[];
};

/**
 * Parse one JSONL file from `startOffset` through end-of-file. Synchronous
 * because Bun's `readSync` is already chunked-friendly and we want strict
 * memory bounds — async iteration is unnecessary for current scale.
 */
export function parseJsonl(filePath: string, startOffset: number = 0): ParseResult {
  const warnings: string[] = [];
  const messages: ParsedMessage[] = [];
  const fd = fs.openSync(filePath, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (stat.size <= startOffset) {
      return { messages, endOffset: startOffset, warnings };
    }
    const stopAt = Math.min(stat.size, startOffset + TOTAL_SCAN_MAX);
    if (stat.size > stopAt) {
      warnings.push(`file ${filePath} > 500MB; parsing first 500MB only`);
    }

    const CHUNK = 64 * 1024;
    const buf = Buffer.alloc(CHUNK);
    let offset = startOffset;
    let pending: Buffer = Buffer.alloc(0);
    let pendingTooLong = false;
    let lineStartOffset = startOffset;

    while (offset < stopAt) {
      const want = Math.min(CHUNK, stopAt - offset);
      const got = fs.readSync(fd, buf, 0, want, offset);
      if (got <= 0) break;
      const chunk = buf.subarray(0, got);
      let chunkPos = 0;
      while (chunkPos < chunk.length) {
        const nl = chunk.indexOf(0x0a, chunkPos);
        if (nl === -1) {
          // No newline in this slice — accumulate.
          const tail = chunk.subarray(chunkPos);
          if (!pendingTooLong) {
            if (pending.length + tail.length > PER_LINE_MAX) {
              pendingTooLong = true;
              pending = Buffer.alloc(0);
            } else {
              pending = pending.length === 0 ? Buffer.from(tail) : Buffer.concat([pending, tail]);
            }
          }
          break;
        }
        // Have a complete line.
        const tail = chunk.subarray(chunkPos, nl);
        const fullLine = pending.length === 0 ? tail : Buffer.concat([pending, tail]);
        const lineEndOffset = offset + nl + 1;
        if (pendingTooLong || fullLine.length > PER_LINE_MAX) {
          warnings.push(
            `skipped JSONL line at offset ${lineStartOffset} in ${filePath}: line exceeds 1MB`,
          );
        } else if (fullLine.length > 0) {
          const text = fullLine.toString("utf8").trim();
          if (text.length > 0) {
            try {
              const parsed = JSON.parse(text);
              messages.push({ raw: parsed, lineEndOffset });
            } catch (err) {
              warnings.push(
                `skipped malformed JSON at offset ${lineStartOffset} in ${filePath}: ${(err as Error).message}`,
              );
            }
          }
        }
        pending = Buffer.alloc(0);
        pendingTooLong = false;
        chunkPos = nl + 1;
        lineStartOffset = lineEndOffset;
      }
      offset += got;
    }

    // If pending buffer is non-empty, the last line lacks a trailing \n.
    // Stop at the last full line per spec.
    return { messages, endOffset: lineStartOffset, warnings };
  } finally {
    fs.closeSync(fd);
  }
}
