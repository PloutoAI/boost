/**
 * Localhost-redirect OAuth flow for the boost CLI.
 *
 * Same pattern as ``gh auth login`` / ``gcloud auth login`` / ``fly auth
 * login``: spin up a tiny HTTP server on an ephemeral local port, open
 * the user's browser to ``PLOUTO_API_URL/cli/login?port=P&state=S``,
 * wait for Plouto to redirect back to ``http://localhost:P/callback?
 * token=…&state=…``, verify the state, return the token.
 *
 * No polling. No device codes. No expiry race. Browser tab closes
 * itself after the success page renders.
 *
 * Times out after 5 minutes — if the user closes the browser tab or
 * forgets, we don't sit forever holding the port.
 */

import { randomBytes } from "node:crypto";

interface AuthResult {
  token: string;
  apiUrl: string;
}

const TIMEOUT_MS = 5 * 60_000;

const SUCCESS_HTML = `<!doctype html>
<meta charset="utf-8">
<title>boost — connected</title>
<style>
  body { font-family: ui-sans-serif, system-ui; padding: 4rem; max-width: 32rem; margin: 0 auto; color: #18181b; }
  h1 { font-size: 1.5rem; margin: 0 0 0.5rem 0; }
  p { color: #71717a; margin: 0.5rem 0 0 0; }
  .ok { color: #047857; font-weight: 600; }
</style>
<h1>You can close this tab.</h1>
<p><span class="ok">boost</span> is now connected to Plouto. Head back to your terminal.</p>
<script>setTimeout(() => window.close(), 1500);</script>
`;

const ERROR_HTML = `<!doctype html>
<meta charset="utf-8">
<title>boost — auth failed</title>
<style>
  body { font-family: ui-sans-serif, system-ui; padding: 4rem; max-width: 32rem; margin: 0 auto; color: #18181b; }
  h1 { color: #be123c; font-size: 1.5rem; margin: 0 0 0.5rem 0; }
  p { color: #71717a; margin: 0.5rem 0 0 0; }
</style>
<h1>Authentication failed.</h1>
<p>State mismatch — please re-run <code>boost install</code> in your terminal.</p>
`;

export interface OAuthOptions {
  apiUrl: string;
  /** Optional override — useful for tests + dev where we don't actually open a browser. */
  openBrowser?: (url: string) => Promise<void> | void;
  /** Print progress to stderr. */
  log?: (msg: string) => void;
}

export async function runOAuthLogin(opts: OAuthOptions): Promise<AuthResult> {
  const apiUrl = opts.apiUrl.replace(/\/+$/, "");
  const state = randomBytes(16).toString("hex");
  const log = opts.log ?? ((m) => process.stderr.write(`boost: ${m}\n`));

  const result = await new Promise<AuthResult>((resolve, reject) => {
    let resolved = false;
    const finish = (ok: AuthResult | null, err?: Error) => {
      if (resolved) return;
      resolved = true;
      try { server.stop(true); } catch { /* already stopped */ }
      clearTimeout(timer);
      if (ok) resolve(ok);
      else reject(err ?? new Error("auth aborted"));
    };

    const server = Bun.serve({
      port: 0,                       // ask OS for an ephemeral port
      hostname: "127.0.0.1",
      async fetch(req: Request): Promise<Response> {
        const url = new URL(req.url);
        if (url.pathname !== "/callback") {
          return new Response("not found", { status: 404 });
        }
        const token = url.searchParams.get("token") ?? "";
        const cbState = url.searchParams.get("state") ?? "";
        const cbApiUrl = url.searchParams.get("api_url") ?? apiUrl;
        if (!token || cbState !== state) {
          finish(null, new Error("state mismatch or missing token in OAuth callback"));
          return new Response(ERROR_HTML, {
            status: 400,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
        finish({ token, apiUrl: cbApiUrl.replace(/\/+$/, "") });
        return new Response(SUCCESS_HTML, {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      },
    });

    const timer = setTimeout(() => {
      finish(null, new Error("OAuth timed out after 5 minutes — re-run boost install"));
    }, TIMEOUT_MS);

    const loginUrl = `${apiUrl}/cli/login?port=${server.port}&state=${state}`;
    log(`opening browser for Plouto auth: ${loginUrl}`);
    Promise.resolve(opts.openBrowser?.(loginUrl) ?? openInBrowser(loginUrl)).catch((err) => {
      log(`couldn't auto-open browser (${(err as Error).message}); paste this URL manually:`);
      log(loginUrl);
    });
  });

  return result;
}

// ---------------------------------------------------------------------------
// Cross-platform browser opener
// ---------------------------------------------------------------------------

async function openInBrowser(url: string): Promise<void> {
  const platform = process.platform;
  const cmd =
    platform === "darwin"  ? ["open", url] :
    platform === "win32"   ? ["cmd", "/c", "start", "", url] :
                             ["xdg-open", url];
  // ``Bun.spawn`` with detached so we don't wait on the browser process.
  const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  // Fire-and-forget — exit code doesn't matter for the user-facing flow.
  void proc.exited.catch(() => undefined);
}
