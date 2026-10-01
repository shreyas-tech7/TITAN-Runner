/**
 * Logic for the God's Eye View tab (the real 3D globe hosted by TITAN-GEV).
 *
 * Everything here is plain TypeScript with no React and no `@/` imports, so the
 * root layout can read it on the server and the tests can run it directly. The
 * `GevController` owns the lifecycle: check that the host is awake, mint a
 * short lived access link through the Worker, show the iframe, and keep
 * watching. A free host sleeps when idle, so "waking" is a normal
 * state with automatic retry, not an error.
 *
 * `NEXT_PUBLIC_GEV_URL` is the host URL. It is not a secret. The access link
 * is, which is why it comes from the Worker and lives about five minutes.
 */

// ---------------------------------------------------------------------
// The host URL
// ---------------------------------------------------------------------

export type GevTarget =
  | { ok: true; origin: string }
  | { ok: false; reason: "unset" | "invalid" };

/**
 * Accept an https origin (or http on loopback for local testing). Everything
 * after the origin is dropped, and a URL with credentials is refused.
 */
export function parseGevUrl(raw: string | undefined): GevTarget {
  const value = (raw ?? "").trim();
  if (!value) return { ok: false, reason: "unset" };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (url.username || url.password) return { ok: false, reason: "invalid" };
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    return { ok: false, reason: "invalid" };
  }
  return { ok: true, origin: url.origin };
}

/**
 * The CSP for the dashboard page. It allows framing the host origin and sets no
 * other directive, so nothing else about the page changes. Null when no host is set.
 */
export function gevFrameSrcPolicy(target: GevTarget): string | null {
  return target.ok ? `frame-src ${target.origin}` : null;
}

/** The iframe address. The token rides in the query only until the host redeems it. */
export function buildGevSrc(origin: string, token: string): string {
  return `${origin}/?gev_token=${encodeURIComponent(token)}`;
}

// ---------------------------------------------------------------------
// Messages from the embedded page
// ---------------------------------------------------------------------

export type GevMessage = "session-blocked" | "unauthorized";

/**
 * The host posts these when the browser drops its cookie or when it sees a 401.
 * Accept a message only from the host origin itself.
 */
export function parseGevMessage(event: { origin: string; data: unknown }, origin: string): GevMessage | null {
  if (event.origin !== origin) return null;
  const data = event.data;
  if (typeof data !== "object" || data === null) return null;
  const type = (data as { type?: unknown }).type;
  if (type === "gev-session-blocked") return "session-blocked";
  if (type === "gev-unauthorized") return "unauthorized";
  return null;
}

// ---------------------------------------------------------------------
// Health and retry
// ---------------------------------------------------------------------

export type HealthResult = "ready" | "starting" | "down";

/**
 * Ask the host whether it is awake. A sleeping host answers with the platform's
 * own wake-up page, which carries no CORS headers, so the fetch fails and the
 * result is "down". An awake gateway answers with its own JSON.
 */
export async function checkGevHealth(
  origin: string,
  { fetchImpl = fetch, timeoutMs = 8000 }: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<HealthResult> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${origin}/healthz`, {
      cache: "no-store",
      credentials: "omit",
      mode: "cors",
      signal: abort.signal,
    });
    let body: { service?: unknown; ok?: unknown } | null = null;
    try {
      body = (await res.json()) as { service?: unknown; ok?: unknown };
    } catch {
      body = null;
    }
    const ours = body !== null && typeof body === "object" && body.service === "titan-gev";
    if (res.ok && ours && body?.ok === true) return "ready";
    return ours ? "starting" : "down";
  } catch {
    return "down";
  } finally {
    clearTimeout(timer);
  }
}

const RETRY_STEPS_MS = [3000, 5000, 8000, 12000, 15000];

/** Back off from 3 seconds to a 15 second ceiling. Retries never stop on their own. */
export function retryDelayMs(attempt: number): number {
  const index = Math.min(Math.max(attempt, 1), RETRY_STEPS_MS.length) - 1;
  return RETRY_STEPS_MS[index];
}

// ---------------------------------------------------------------------
// Access link
// ---------------------------------------------------------------------

export type MintResult =
  | { kind: "ok"; token: string }
  | { kind: "unauthorized" }
  | { kind: "not-configured"; what: "secret" | "worker" }
  | { kind: "error"; message: string };

/** Translate a failed Worker call (a `WorkerApiError`) into a mint result. */
export function toMintResult(error: unknown): MintResult {
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? (error as { status: number | null }).status
      : null;
  const message = error instanceof Error ? error.message : "The access link request failed.";
  if (status === 401) return { kind: "unauthorized" };
  if (status === 503 && message === "gev_not_configured") return { kind: "not-configured", what: "secret" };
  return { kind: "error", message };
}

/**
 * Open the globe as a top level page. The blank window opens first, inside the
 * click, so popup blockers allow it. The access link arrives afterward.
 */
export async function openGevFullScreen(deps: {
  origin: string;
  mint: () => Promise<MintResult>;
  openBlank: () => { location: { replace: (url: string) => void }; close: () => void; opener?: unknown } | null;
}): Promise<"opened" | "popup-blocked" | "failed"> {
  const win = deps.openBlank();
  if (!win) return "popup-blocked";
  try {
    win.opener = null;
  } catch {
    // Some browsers refuse. The new page is still ours.
  }
  const result = await deps.mint();
  if (result.kind !== "ok") {
    win.close();
    return "failed";
  }
  win.location.replace(buildGevSrc(deps.origin, result.token));
  return "opened";
}

// ---------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------

export type GevPhase = "empty" | "checking" | "waking" | "minting" | "ready" | "unconfigured" | "error";

export interface GevState {
  phase: GevPhase;
  /** The iframe address while the phase is "ready". */
  src: string | null;
  /** Null until the first health check answers. */
  reachable: boolean | null;
  /** Failed health checks since the last good one. Shown while waking. */
  attempts: number;
  message: string | null;
  /** What is missing when the phase is "unconfigured". */
  missing: "secret" | "worker" | null;
  /** The embedded page reported that the browser dropped its cookie. */
  sessionBlocked: boolean;
  /** Changes whenever the iframe must reload, so React remounts it. */
  frameKey: number;
  /** For the empty state: why there is no host URL. */
  emptyReason: "unset" | "invalid" | null;
}

export const INITIAL_GEV_STATE: GevState = {
  phase: "checking",
  src: null,
  reachable: null,
  attempts: 0,
  message: null,
  missing: null,
  sessionBlocked: false,
  frameKey: 0,
  emptyReason: null,
};

export interface GevControllerDeps {
  target: GevTarget;
  mint: () => Promise<MintResult>;
  checkHealth: (origin: string) => Promise<HealthResult>;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  onState: (state: GevState) => void;
  onUnauthorized: () => void;
  now?: () => number;
}

const MONITOR_INTERVAL_MS = 30_000;
const MINT_RETRY_MS = 15_000;
// The host ends a session after 6 hours. Start a fresh one before that.
const SESSION_REFRESH_MS = 5.5 * 60 * 60 * 1000;
const AUTO_RELOAD_WINDOW_MS = 120_000;
const AUTO_RELOAD_LIMIT = 2;

export class GevController {
  private deps: GevControllerDeps;
  private state: GevState = INITIAL_GEV_STATE;
  private timer: unknown = null;
  private refreshTimer: unknown = null;
  private run = 0;
  private stopped = true;
  private missedChecks = 0;
  private autoReloads: number[] = [];

  constructor(deps: GevControllerDeps) {
    this.deps = deps;
  }

  getState(): GevState {
    return this.state;
  }

  start(): void {
    this.stopped = false;
    const gen = ++this.run;
    const { target } = this.deps;
    if (!target.ok) {
      this.set({ ...INITIAL_GEV_STATE, phase: "empty", emptyReason: target.reason });
      return;
    }
    this.set({ ...INITIAL_GEV_STATE });
    void this.probe(gen, target.origin);
  }

  stop(): void {
    this.stopped = true;
    this.run += 1;
    this.clearTimers();
  }

  /** Mint a fresh access link and remount the iframe. */
  reload(): void {
    const { target } = this.deps;
    if (this.stopped || !target.ok) return;
    const gen = ++this.run;
    this.clearTimers();
    this.missedChecks = 0;
    this.set({ ...this.state, phase: "checking", src: null, attempts: 0, message: null, sessionBlocked: false });
    void this.probe(gen, target.origin);
  }

  /** Handle a message that the embedded page posted. */
  reportMessage(message: GevMessage): void {
    if (this.stopped) return;
    if (message === "session-blocked") {
      this.set({ ...this.state, sessionBlocked: true });
      return;
    }
    // A 401 inside the frame means its access link was used up or expired.
    const now = (this.deps.now ?? Date.now)();
    this.autoReloads = this.autoReloads.filter((at) => now - at < AUTO_RELOAD_WINDOW_MS);
    if (this.autoReloads.length >= AUTO_RELOAD_LIMIT) {
      this.clearTimers();
      this.set({
        ...this.state,
        phase: "error",
        src: null,
        message: "The globe keeps rejecting its access link. Check that GEV_SHARED_SECRET matches on the Worker and the host.",
      });
      return;
    }
    this.autoReloads.push(now);
    this.reload();
  }

  private set(next: GevState): void {
    this.state = next;
    this.deps.onState(next);
  }

  private clearTimers(): void {
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    if (this.refreshTimer !== null) this.deps.clearTimer(this.refreshTimer);
    this.timer = null;
    this.refreshTimer = null;
  }

  private async probe(gen: number, origin: string): Promise<void> {
    const health = await this.deps.checkHealth(origin);
    if (gen !== this.run) return;
    if (health === "ready") {
      await this.mintAndShow(gen, origin);
      return;
    }
    const attempts = this.state.attempts + 1;
    this.set({ ...this.state, phase: "waking", reachable: false, attempts, message: null, src: null });
    this.timer = this.deps.setTimer(() => {
      void this.probe(gen, origin);
    }, retryDelayMs(attempts));
  }

  private async mintAndShow(gen: number, origin: string): Promise<void> {
    this.set({ ...this.state, phase: "minting", reachable: true, attempts: 0 });
    const result = await this.deps.mint();
    if (gen !== this.run) return;
    switch (result.kind) {
      case "ok":
        this.missedChecks = 0;
        this.set({
          ...this.state,
          phase: "ready",
          src: buildGevSrc(origin, result.token),
          reachable: true,
          message: null,
          sessionBlocked: false,
          frameKey: this.state.frameKey + 1,
        });
        this.scheduleMonitor(gen, origin);
        this.refreshTimer = this.deps.setTimer(() => this.reload(), SESSION_REFRESH_MS);
        return;
      case "unauthorized":
        this.set({ ...this.state, phase: "error", message: "The Worker rejected your admin token." });
        this.deps.onUnauthorized();
        return;
      case "not-configured":
        this.set({ ...this.state, phase: "unconfigured", missing: result.what });
        return;
      case "error":
        this.set({ ...this.state, phase: "error", message: result.message });
        this.timer = this.deps.setTimer(() => {
          void this.probe(gen, origin);
        }, MINT_RETRY_MS);
        return;
    }
  }

  private scheduleMonitor(gen: number, origin: string): void {
    this.timer = this.deps.setTimer(() => {
      void (async () => {
        const health = await this.deps.checkHealth(origin);
        if (gen !== this.run) return;
        if (health === "ready") {
          this.missedChecks = 0;
          if (this.state.reachable !== true) this.set({ ...this.state, reachable: true });
        } else {
          this.missedChecks += 1;
          // One missed check is noise. Two in a row is worth showing.
          if (this.missedChecks >= 2 && this.state.reachable !== false) {
            this.set({ ...this.state, reachable: false });
          }
        }
        this.scheduleMonitor(gen, origin);
      })();
    }, MONITOR_INTERVAL_MS);
  }
}
