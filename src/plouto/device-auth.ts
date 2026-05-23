/**
 * Device-code OAuth flow (RFC 8628, gh / aws / stripe style).
 *
 *   1. POST PLOUTO_API_URL/api/auth/device/start
 *      → { device_code, user_code, verification_uri, ... }
 *   2. Show the user_code; either auto-open the prefilled
 *      verification URL or (over SSH) just print it for the user
 *      to paste on their local machine.
 *   3. Poll GET PLOUTO_API_URL/api/auth/device/poll/{device_code}
 *      every ``interval`` seconds. During the wait, render a
 *      braille-frame spinner + a M:SS countdown to expiry.
 *   4. On completion: return token + identity info (email, name,
 *      workspace) so the caller can print "✓ Logged in as X" the
 *      way gh / stripe / vercel do.
 *
 * Why this rather than the localhost-redirect pattern:
 *   - Works over SSH (no need to open a port on the remote box).
 *   - Cleaner URL — no ``?port=…&state=…`` in what the user sees.
 *   - Doesn't require us to spin up an HTTP server in the CLI.
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
  user_email?: string | null;
  user_name?: string | null;
  workspace_name?: string | null;
}

export interface DeviceAuthResult {
  token: string;
  apiUrl: string;
  userEmail?: string;
  userName?: string;
  workspaceName?: string;
}

export interface DeviceAuthOptions {
  apiUrl: string;
  /** Override the browser-opener (used by tests). */
  openBrowser?: (url: string) => Promise<void> | void;
  /** Override log output (default: stderr). */
  log?: (msg: string) => void;
  /** Override the SSH check (used by tests). */
  isSSH?: () => boolean;
  /** Disable the live spinner / countdown (used when not a TTY or in tests). */
  noSpinner?: boolean;
}

const POLL_TIMEOUT_MS = 10 * 60_000;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export async function runDeviceAuth(opts: DeviceAuthOptions): Promise<DeviceAuthResult> {
  const apiUrl = opts.apiUrl.replace(/\/+$/, "");
  const log = opts.log ?? ((m) => process.stderr.write(m + "\n"));
  const sshDetected = (opts.isSSH ?? isSSHSession)();
  const ttyOk = process.stderr.isTTY && !opts.noSpinner;

  const start = await postStart(apiUrl);

  // Header — gh-style: bold one-time code, separator line, bare URL,
  // explicit "what we're about to do" so the user isn't surprised.
  log("");
  log(`  ${dim("!")} First copy your one-time code: ${bold(start.user_code)}`);
  if (sshDetected) {
    log(`  ${dim("→")} Open this URL on your local machine:`);
    log(`     ${start.verification_uri}`);
  } else {
    log(`  ${dim("→")} Open: ${start.verification_uri}`);
    log("");
    log(`  ${dim("(opening browser automatically — paste the URL above if it doesn't)")}`);
    try {
      await Promise.resolve(opts.openBrowser?.(start.verification_uri_complete)
        ?? openInBrowser(start.verification_uri_complete));
    } catch {
      // Auto-open failed — URL is already in scrollback, nothing to do.
    }
  }
  log("");

  // Spinner + countdown loop. Re-prints a single line via \r so we
  // don't flood the terminal during the wait. Falls back to a static
  // message when stderr isn't a TTY (CI, piped output).
  const startedAt = Date.now();
  const deadline = startedAt + Math.min(POLL_TIMEOUT_MS, start.expires_in * 1000);
  let interval = (start.interval ?? 5) * 1000;
  let frame = 0;
  let spinnerTimer: ReturnType<typeof setInterval> | null = null;
  let lastLine = "";

  const renderSpinner = () => {
    if (!ttyOk) return;
    const remaining = Math.max(0, deadline - Date.now());
    const mm = Math.floor(remaining / 60_000);
    const ss = String(Math.floor((remaining % 60_000) / 1000)).padStart(2, "0");
    const line = `  ${SPINNER_FRAMES[frame]} Waiting for you to authorize — ${dim(`expires in ${mm}:${ss}`)}`;
    process.stderr.write("\r" + " ".repeat(lastLine.length) + "\r" + line);
    lastLine = line;
    frame = (frame + 1) % SPINNER_FRAMES.length;
  };
  const clearSpinner = () => {
    if (spinnerTimer) clearInterval(spinnerTimer);
    if (ttyOk && lastLine) {
      process.stderr.write("\r" + " ".repeat(lastLine.length) + "\r");
    }
  };

  if (ttyOk) {
    renderSpinner();
    spinnerTimer = setInterval(renderSpinner, 100);
  } else {
    log("Waiting for you to authorize…");
  }

  try {
    while (Date.now() < deadline) {
      await sleep(interval);
      const poll = await postPoll(apiUrl, start.device_code);

      if (poll.status === "completed") {
        if (!poll.token) {
          throw new Error("Plouto returned status=completed without a token — try `boost auth login` again.");
        }
        clearSpinner();
        return {
          token: poll.token,
          apiUrl: (poll.api_url ?? apiUrl).replace(/\/+$/, ""),
          userEmail: poll.user_email ?? undefined,
          userName: poll.user_name ?? undefined,
          workspaceName: poll.workspace_name ?? undefined,
        };
      }
      if (poll.status === "expired") {
        clearSpinner();
        throw new Error("Device code expired (10-minute window). Re-run the install command.");
      }
      if (poll.status === "denied") {
        clearSpinner();
        throw new Error("Authorization denied.");
      }
      if (poll.status === "not_found") {
        clearSpinner();
        throw new Error("Device code disappeared on the server — re-run the install command.");
      }
      // status === "pending" — keep waiting. Server can adjust interval.
      if (poll.interval) interval = poll.interval * 1000;
    }
    clearSpinner();
    throw new Error("Device auth timed out — re-run `boost install`.");
  } finally {
    clearSpinner();
  }
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

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

function bold(s: string): string {
  return `\x1b[1m${s}\x1b[0m`;
}

function dim(s: string): string {
  return `\x1b[2m${s}\x1b[0m`;
}

// ---------------------------------------------------------------------------
// Environment detection
// ---------------------------------------------------------------------------

function isSSHSession(): boolean {
  // ``SSH_CLIENT`` / ``SSH_TTY`` / ``SSH_CONNECTION`` are set by sshd
  // on the remote side. If any is set we can't sensibly auto-open the
  // browser (the remote box probably has no DISPLAY / GUI).
  return Boolean(
    process.env.SSH_CLIENT
    || process.env.SSH_TTY
    || process.env.SSH_CONNECTION,
  );
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
