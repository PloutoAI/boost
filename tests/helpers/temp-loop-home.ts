/**
 * Test helper: spin up a fresh `$BOOST_HOME` (and optionally `$CLAUDE_CONFIG_DIR`)
 * for the duration of a test.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type TempLoopHome = {
  loopHome: string;
  claudeHome: string;
  cleanup: () => void;
};

export function makeTempHome(): TempLoopHome {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "boost-test-"));
  const loopHome = path.join(root, "boost");
  const claudeHome = path.join(root, "claude");
  fs.mkdirSync(loopHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(claudeHome, { recursive: true, mode: 0o700 });
  process.env.BOOST_HOME = loopHome;
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  return {
    loopHome,
    claudeHome,
    cleanup: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        // ignore
      }
      delete process.env.BOOST_HOME;
      delete process.env.CLAUDE_CONFIG_DIR;
    },
  };
}
