/**
 * Device-code OAuth flow (RFC 8628, gh / aws / stripe style).
 *
 *   1. POST PLOUTO_API_URL/api/auth/device/start
 *      → { device_code, user_code, verification_uri, ... }
 *   2. Show the user_code to the engineer + ask them to open the
 *      verification_uri (and try to auto-open the browser).
 *   3. Poll GET PLOUTO_API_URL/api/auth/device/poll/{device_code}
 *      every ``interval`` seconds until status=completed or expired.
 *   4. Return the token + the (possibly-canonical) api_url from the
 *      successful poll response.
 *
 * Why this rather than the localhost-redirect pattern:
 *   - Works over SSH (no need to open a port on the remote box).
 *   - Cleaner URL — no ``?port=…&state=…`` in what the user sees.
 *   - Doesn't require us to spin up an HTTP server in the CLI.
 *
 * The flow times out after 10 minutes — matches the server's
 * session expiry so we don't sit polling against a dead code.
 */

interface DeviceStartResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

interface DevicePollResponse {
  status: "pending" | "completed" | "expired" | "denied" | "not_found";
  token?: string;
  api_url?: string;
  interval?: number;
}

export interface DeviceAuthResult {
  token: string;
  apiUrl: string;
}

export interface DeviceAuthOptions {
  apiUrl: string;
  /** Override the browser-opener (used by tests). */
  openBrowser?: (url: string) => Promise<void> | void;
  /** Override log output (default: stderr). */
  log?: (msg: string) => void;
}

const POLL_TIMEOUT_MS = 10 * 60_000;

export async function runDeviceAuth(opts: DeviceAuthOptions): Promise<DeviceAuthResult> {
  const apiUrl = opts.apiUrl.replace(/\/+$/, "");
  const log = opts.log ?? ((m) => process.stderr.write(m + "\n"));

  const start = await postStart(apiUrl);

  // User-facing message — keep it gh-style. Visible code, clean URL,
  // no `?port=…`. Best effort to open the browser; users who SSH'd in
  // simply paste the URL from their terminal scrollback.
  log("");
  log("  ! First copy your one-time code: " + bold(start.user_code));
  log("  Then open: " + start.verification_uri);
  log("");
  log("Waiting for you to authorize…");
  log("");

  try {
    await Promise.resolve(opts.openBrowser?.(start.verification_uri_complete) ?? openInBrowser(start.verification_uri_complete));
  } catch {
    // Auto-open failed — the user has the URL in their scrollback,
    // they can navigate manually. No need to surface this as an error.
  }

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let interval = (start.interval ?? 5) * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    const poll = await postPoll(apiUrl, start.device_code);
    if (poll.status === "completed") {
      if (!poll.token) {
        throw new Error("Plouto returned status=completed without a token — try `boost auth login` again.");
      }
      return {
        token: poll.token,
        apiUrl: (poll.api_url ?? apiUrl).replace(/\/+$/, ""),
      };
    }
    if (poll.status === "expired") {
      throw new Error("Device code expired (10-minute window). Re-run the install command.");
    }
    if (poll.status === "denied") {
      throw new Error("Authorization denied.");
    }
    if (poll.status === "not_found") {
      throw new Error("Device code disappeared on the server — re-run the install command.");
    }
    // status === "pending" — keep waiting. Server can adjust interval.
    if (poll.interval) interval = poll.interval * 1000;
  }
  throw new Error("Device auth timed out — re-run `boost install`.");
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function postStart(apiUrl: string): Promise<DeviceStartResponse> {
  const resp = await fetch(`${apiUrl}/api/auth/device/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "boost" }),
  });
  if (!resp.ok) {
    throw new Error(`Plouto /api/auth/device/start returned ${resp.status}`);
  }
  return (await resp.json()) as DeviceStartResponse;
}

async function postPoll(apiUrl: string, deviceCode: string): Promise<DevicePollResponse> {
  const resp = await fetch(
    `${apiUrl}/api/auth/device/poll/${encodeURIComponent(deviceCode)}`,
    { method: "GET" },
  );
  if (!resp.ok) {
    throw new Error(`Plouto /api/auth/device/poll returned ${resp.status}`);
  }
  return (await resp.json()) as DevicePollResponse;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function bold(s: string): string {
  // ANSI bold + reset. Terminals that don't render escape codes just
  // see the literal — same UX gh has when it bolds the code.
  return `\x1b[1m${s}\x1b[0m`;
}

// ---------------------------------------------------------------------------
// Cross-platform browser opener
// ---------------------------------------------------------------------------

async function openInBrowser(url: string): Promise<void> {
  const cmd =
    process.platform === "darwin"  ? ["open", url] :
    process.platform === "win32"   ? ["cmd", "/c", "start", "", url] :
                                     ["xdg-open", url];
  const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  void proc.exited.catch(() => undefined);
}
