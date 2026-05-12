/**
 * `boost revert` — list recent operations and revert the chosen one.
 */
import * as readline from "node:readline";
import { LoopDatabase } from "./db.ts";
import { recentOperations, revertOperation } from "./apply/revert.ts";

export type RevertCommandOptions = {
  debug?: boolean;
};

export async function revertCommand(
  operationId: string | undefined,
  _opts: RevertCommandOptions = {},
): Promise<void> {
  const handle = LoopDatabase.open();
  const db = handle.db;

  if (operationId) {
    await revertOperation(db, operationId);
    process.stdout.write(`✓ reverted ${operationId}\n`);
    return;
  }

  const ops = recentOperations(db, 20);
  if (ops.length === 0) {
    process.stdout.write("No operations to revert.\n");
    return;
  }

  process.stdout.write("Recent operations:\n");
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    const status = op.revertedAtIso ? "[reverted]" : "[active]";
    const ago = humanAgo(op.appliedAtIso);
    process.stdout.write(`  ${(i + 1).toString().padStart(2)}. ${ago.padEnd(14)} — ${op.strategyId} ${status}\n`);
  }
  process.stdout.write("\nRevert which? [number, or q to quit] > ");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer: string = await new Promise((resolve) => rl.question("", (a) => resolve(a)));
  rl.close();

  const trimmed = answer.trim().toLowerCase();
  if (trimmed === "" || trimmed === "q") return;
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n < 1 || n > ops.length) {
    process.stderr.write(`not a valid choice: ${answer}\n`);
    process.exit(2);
  }
  const op = ops[n - 1]!;
  if (op.revertedAtIso) {
    process.stdout.write(`already reverted: ${op.operationId}\n`);
    return;
  }
  await revertOperation(db, op.operationId);
  process.stdout.write(`✓ reverted ${op.operationId} (${op.strategyId})\n`);
}

function humanAgo(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const sec = Math.floor((Date.now() - t) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}
