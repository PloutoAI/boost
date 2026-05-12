/**
 * Anonymous identity bootstrap. Creates `~/.boost/identity.json` on first run
 * with random opaque IDs (we deliberately avoid real machine identifiers).
 */
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { identityPath } from "./paths.ts";

export type Identity = {
  user_id: string;
  machine_id: string;
  created_at_iso: string;
  schema_version: 1;
};

/** Load identity, creating the file with mode 0600 if missing. */
export function loadOrCreateIdentity(): Identity {
  const file = identityPath();
  if (fs.existsSync(file)) {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (err) {
      throw new Error(`couldn't read ${file}: ${(err as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        `${file} is corrupt. Move it aside and rerun boost to regenerate.`,
      );
    }
    if (!isIdentity(parsed)) {
      throw new Error(`${file} has unexpected shape; refusing to use.`);
    }
    return parsed;
  }
  const fresh: Identity = {
    user_id: `boost_${randomUUID()}`,
    machine_id: `boostm_${randomUUID()}`,
    created_at_iso: new Date().toISOString(),
    schema_version: 1,
  };
  fs.writeFileSync(file, JSON.stringify(fresh, null, 2), { mode: 0o600 });
  return fresh;
}

function isIdentity(x: unknown): x is Identity {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o["user_id"] === "string" &&
    typeof o["machine_id"] === "string" &&
    typeof o["created_at_iso"] === "string" &&
    o["schema_version"] === 1
  );
}
