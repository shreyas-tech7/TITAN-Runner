/**
 * Read-only fixture data for `?demo=1` (Wave 12, V1).
 *
 * A visitor who opens any dashboard page with `?demo=1` sees a complete, realistic TITAN-Runner sample without entering
 * an admin token or touching the live Worker. Every write route returns a polite read-only message in demo mode.
 */
import { PROVIDER_CATALOG } from "./providers";

const DEMO_STORAGE_KEY = "titan_demo_mode";

export function isDemoMode(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("demo") === "1") {
      window.sessionStorage.setItem(DEMO_STORAGE_KEY, "1");
      return true;
    }
    if (params.get("demo") === "0") {
      window.sessionStorage.removeItem(DEMO_STORAGE_KEY);
      return false;
    }
    return window.sessionStorage.getItem(DEMO_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function exitDemoMode(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(DEMO_STORAGE_KEY);
    const url = new URL(window.location.href);
    url.searchParams.delete("demo");
    window.location.assign(url.toString());
  } catch {
    // ignore
  }
}

const NOW = "2026-10-11T03:00:00.000Z";
const MIN_5_AGO = "2026-10-11T02:55:00.000Z";
const MIN_20_AGO = "2026-10-11T02:40:00.000Z";
const HOUR_2_AGO = "2026-10-11T01:00:00.000Z";

export function getDemoStateFile(statePath: string): unknown | null {
  const clean = statePath.replace(/^state\//, "");
  if (clean === "heartbeat.json") {
    return {
      lastPulseAt: MIN_5_AGO,
      lastRunId: "184291044",
      lastRunUrl: "https://github.com/shreyas-tech7/TITAN-Runner/actions/runs/184291044",
      lastStatus: "ok",
      lastDurationMs: 14200,
      activeProvider: "groq",
      activeModel: "llama-3.3-70b-versatile",
      tasksProcessed: 2,
      pendingApprovals: 1,
    };
  }
  if (clean === "tasks.json") {
    return {
      updatedAt: MIN_5_AGO,
      tasks: [
        {
          id: "task-demo-101",
          title: "Summarize arXiv mechanistic interpretability papers from the last 48 hours",
          status: "done",
          priority: "normal",
          createdAt: HOUR_2_AGO,
          updatedAt: MIN_20_AGO,
          provider: "groq",
          model: "llama-3.3-70b-versatile",
          summary: "Compiled 4 papers on sparse autoencoders and circuit tracing with links and key findings.",
        },
        {
          id: "task-demo-102",
          title: "Verify connector manifest schemas and test coverage",
          status: "running",
          priority: "high",
          createdAt: MIN_20_AGO,
          updatedAt: MIN_5_AGO,
          provider: "gemini",
          model: "gemini-2.5-flash",
          summary: "Running 15-connector manifest checks and workerd integration assertions.",
        },
        {
          id: "task-demo-103",
          title: "Draft weekly reliability digest for Telegram and Discord",
          status: "queued",
          priority: "normal",
          createdAt: MIN_5_AGO,
          updatedAt: MIN_5_AGO,
        },
      ],
    };
  }
  if (clean === "providers.json") {
    return {
      updatedAt: MIN_5_AGO,
      providers: {
        groq: { status: "healthy", latencyMs: 180, lastCheckedAt: MIN_5_AGO, model: "llama-3.3-70b-versatile" },
        gemini: { status: "healthy", latencyMs: 240, lastCheckedAt: MIN_5_AGO, model: "gemini-2.5-flash" },
        openrouter: { status: "healthy", latencyMs: 310, lastCheckedAt: MIN_5_AGO, model: "meta-llama/llama-3.3-70b-instruct:free" },
        mistral: { status: "healthy", latencyMs: 260, lastCheckedAt: MIN_5_AGO, model: "mistral-small-latest" },
      },
    };
  }
  if (clean === "pulse-history.json") {
    return {
      pulses: Array.from({ length: 12 }, (_, idx) => ({
        at: new Date(Date.parse(NOW) - idx * 15 * 60_000).toISOString(),
        status: "ok",
        durationMs: 12000 + (idx % 4) * 1100,
        provider: idx % 3 === 0 ? "gemini" : "groq",
        tasksRun: idx % 2,
      })),
    };
  }
  if (clean === "agents.json") {
    return {
      updatedAt: MIN_5_AGO,
      agents: [
        { id: "researcher", name: "Researcher", role: "Finds papers, docs, and benchmarks", status: "idle" },
        { id: "builder", name: "Builder", role: "Runs code and test checks in Actions", status: "busy" },
        { id: "auditor", name: "Auditor", role: "Checks STE rules, secrets, and policies", status: "idle" },
      ],
    };
  }
  // The ops mirrors (RD1). The numbers are samples. No provider or host here is real.
  if (clean === "ops/health.json") {
    return {
      contract: "1", generated_at: HOUR_2_AGO,
      providers: {
        groq: { "llama-3.3-70b-versatile": { status: "healthy", latency_ms: 310, checked_at: HOUR_2_AGO, error_class: null } },
        gemini: { "gemini-2.5-flash": { status: "degraded", latency_ms: 9200, checked_at: HOUR_2_AGO, error_class: "slow" } },
        openrouter: { "meta-llama/llama-3.3-70b-instruct:free": { status: "down", latency_ms: null, checked_at: HOUR_2_AGO, error_class: "rate_limited" } },
        together: { unknown: { status: "not_configured", latency_ms: null, checked_at: HOUR_2_AGO, error_class: "no_key" } },
      },
    };
  }
  if (clean === "ops/quota.json") {
    return {
      contract: "1", generated_at: MIN_20_AGO,
      providers: {
        groq: { "llama-3.3-70b-versatile": { limit_day: 1000, used_day: 742, limit_month: null, used_month: 9120, remaining_pct: 25.8, resets_at: "2026-10-12T00:00:00.000Z", exhausted: false, limit_source: "https://console.groq.com/docs/rate-limits", limit_confidence: "observed" } },
        gemini: { "gemini-2.5-flash": { limit_day: null, used_day: 61, limit_month: null, used_month: 802, remaining_pct: null, resets_at: "2026-10-12T00:00:00.000Z", exhausted: false, limit_source: null, limit_confidence: "unknown" } },
        openrouter: { "meta-llama/llama-3.3-70b-instruct:free": { limit_day: 50, used_day: 50, limit_month: null, used_month: 410, remaining_pct: 0, resets_at: "2026-10-12T00:00:00.000Z", exhausted: true, limit_source: "https://openrouter.ai/docs/api-reference/limits", limit_confidence: "official" } },
      },
    };
  }
  if (clean === "ops/eval.json") {
    return {
      contract: "1", generated_at: "2026-10-04T18:10:00.000Z", eval_version: "v1",
      models: {
        "llama-3.3-70b-versatile": {
          "code-generation": { score: 0.92, tasks_run: 2, run_at: "2026-10-04T18:10:00.000Z", eval_version: "v1" },
          debugging: { score: 0.75, tasks_run: 2, run_at: "2026-10-04T18:10:00.000Z", eval_version: "v1" },
          research: { score: 1, tasks_run: 2, run_at: "2026-10-04T18:10:00.000Z", eval_version: "v1" },
          "security-review": { score: 0.4, tasks_run: 1, run_at: "2026-10-04T18:10:00.000Z", eval_version: "v1" },
        },
        "gemini-2.5-flash": {
          "code-generation": { score: 0.6, tasks_run: 2, run_at: "2026-10-04T18:10:00.000Z", eval_version: "v1" },
          research: { score: 0.5, tasks_run: 2, run_at: "2026-10-04T18:10:00.000Z", eval_version: "v1" },
        },
      },
    };
  }
  if (clean === "ops/hosts.json") {
    return {
      contract: "1", generated_at: MIN_20_AGO,
      hosts: {
        github_actions: { status: "up", last_check: MIN_20_AGO, uptime_24h: 100, uptime_7d: 99.6, uptime_30d: 99.1, last_pulse_at: MIN_5_AGO },
        github_status: { status: "up", last_check: MIN_20_AGO, uptime_24h: 100, uptime_7d: 100, uptime_30d: 100 },
        render_1: { status: "asleep", last_check: MIN_20_AGO, uptime_24h: 100, uptime_7d: 100, uptime_30d: 98.7 },
        hermes_1: { status: "down", last_check: MIN_20_AGO, uptime_24h: 62.5, uptime_7d: 91.4, uptime_30d: 96.2 },
      },
    };
  }
  if (clean === "lessons.jsonl") {
    return [
      { id: "les_demo_1", signature: "rate_limited|429", first_seen: HOUR_2_AGO, last_seen: MIN_20_AGO, count: 4, task_type: "research", what_failed: "A research task met a 429 from a free provider.", likely_cause: "Two tasks ran on the same provider in one minute.", suggested_fix: "Spread the steps over more providers, and wait for the reset before a retry.", source: "template" },
      { id: "les_demo_2", signature: "bad_format|json", first_seen: HOUR_2_AGO, last_seen: HOUR_2_AGO, count: 1, task_type: "code", what_failed: "A planning step returned text that was not valid JSON.", likely_cause: "The model added a sentence before the JSON.", suggested_fix: "Ask for JSON only, and retry once with the parse error.", source: "model" },
    ];
  }
  if (clean === "quota.json") {
    return {
      updatedAt: MIN_5_AGO,
      providers: {
        groq: { requestsToday: 42, tokensToday: 68400, dailyRequestLimit: 1000 },
        gemini: { requestsToday: 19, tokensToday: 31200, dailyRequestLimit: 1500 },
        openrouter: { requestsToday: 8, tokensToday: 12900, dailyRequestLimit: 200 },
      },
    };
  }
  return null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "X-Request-Id": "req_demo_fixture" },
  });
}

export function handleDemoWorkerCall(path: string, init: RequestInit = {}): Response {
  const method = (init.method || "GET").toUpperCase();
  const url = new URL(path, "https://demo.titan.local");
  const p = url.pathname;

  if (method === "POST" && p === "/chat") {
    const sse = [
      `event: meta\ndata: ${JSON.stringify({ threadId: "thr_demo_1", provider: "groq", model: "llama-3.3-70b-versatile" })}\n\n`,
      `event: delta\ndata: ${JSON.stringify({ text: "In demo mode, TITAN streams instant replies from your free provider keys (Groq, Gemini, OpenRouter, or Cerebras) " })}\n\n`,
      `event: delta\ndata: ${JSON.stringify({ text: "and automatically fails over if one provider hits a 429 rate limit." })}\n\n`,
      `event: done\ndata: ${JSON.stringify({ threadId: "thr_demo_1", provider: "groq", model: "llama-3.3-70b-versatile", tokensIn: 28, tokensOut: 36, ms: 210 })}\n\n`,
    ].join("");
    return new Response(sse, {
      status: 200,
      headers: { "Content-Type": "text/event-stream; charset=utf-8" },
    });
  }

  if (method !== "GET") {
    return jsonResponse(
      {
        error: "demo_read_only",
        message: "Demo mode is read-only. Exit demo mode and unlock with your admin token to make changes.",
        requestId: "req_demo_readonly",
      },
      403,
    );
  }

  if (p === "/status") {
    return jsonResponse({
      subagents: [
        {
          id: "sa_demo_1",
          task_type: "research",
          brief: "Compare WebCrypto X25519 sealed-box latency against tweetnacl in Cloudflare Workers",
          status: "done",
          source: "dashboard",
          provider: "groq",
          queued_at: HOUR_2_AGO,
          started_at: HOUR_2_AGO,
          finished_at: MIN_20_AGO,
          result_summary: "WebCrypto completes in 0.14 ms per seal in workerd, well under the 5 ms budget.",
          run_url: "https://github.com/shreyas-tech7/TITAN-Runner/actions",
          tokens_used: 1840,
        },
        {
          id: "sa_demo_2",
          task_type: "code",
          brief: "Verify 15 connector manifests and MCP OAuth 2.1 PKCE S256 token rotation",
          status: "running",
          source: "meta-agent",
          provider: "gemini",
          queued_at: MIN_20_AGO,
          started_at: MIN_5_AGO,
          finished_at: null,
          result_summary: null,
          run_url: "https://github.com/shreyas-tech7/TITAN-Runner/actions",
          tokens_used: null,
        },
      ],
      providers: [
        { provider: "groq", configured: 1, updated_at: HOUR_2_AGO },
        { provider: "gemini", configured: 1, updated_at: HOUR_2_AGO },
        { provider: "openrouter", configured: 1, updated_at: HOUR_2_AGO },
      ],
      learningPaths: [
        {
          id: 1,
          subagent_id: "sa_demo_1",
          topic: "Cloudflare Workers CPU Budgets & WebCrypto",
          tree: JSON.stringify({
            topic: "Cloudflare Workers CPU Budgets & WebCrypto",
            prerequisites: [
              { topic: "X25519 + Blake2b Nonce Derivation", reason: "Required for libsodium crypto_box_seal compatibility" },
              { topic: "AES-256-GCM Additional Authenticated Data", reason: "Binds each vault secret to its connection and connector id" },
            ],
            resources: ["docs/KEYS.md", "docs/CONNECTORS.md"],
          }),
          created_at: MIN_20_AGO,
        },
      ],
      generatedAt: NOW,
    });
  }

  if (p === "/admin/keys") {
    return jsonResponse({
      providers: PROVIDER_CATALOG.map((cat, idx) => ({
        ...cat,
        state: idx < 3 ? "pulse_ok" : "unconfigured",
        fingerprint: idx < 3 ? `demo0000000${idx}` : null,
        last4: idx < 3 ? `9a0${idx}` : null,
        alsoForChat: idx < 2,
        savedAt: idx < 3 ? HOUR_2_AGO : null,
        savedVia: idx < 3 ? "dashboard" : null,
        lastVerifiedAt: idx < 3 ? MIN_20_AGO : null,
        lastVerifyStatus: idx < 3 ? 200 : null,
        lastVerifyError: null,
        lastRunnerProofAt: idx < 3 ? MIN_5_AGO : null,
        lastRunnerProofRunId: idx < 3 ? "184291044" : null,
        lastPulseAt: idx < 3 ? MIN_5_AGO : null,
        lastPulseStatus: idx < 3 ? "ok" : null,
        lastError: null,
      })),
      generatedAt: NOW,
    });
  }

  if (p === "/admin/keys/events") {
    return jsonResponse({
      events: [
        { id: 3, at: MIN_5_AGO, provider: "groq", action: "runner_proof", source: "workflow", result: "ok", http_status: 200, fingerprint: "demo00000000", message: "Verified in selftest workflow" },
        { id: 2, at: MIN_20_AGO, provider: "gemini", action: "save", source: "dashboard", result: "ok", http_status: 200, fingerprint: "demo00000001", message: "Sealed to GitHub Secrets and chat vault" },
        { id: 1, at: HOUR_2_AGO, provider: "groq", action: "save", source: "dashboard", result: "ok", http_status: 200, fingerprint: "demo00000000", message: "Sealed to GitHub Secrets and chat vault" },
      ],
    });
  }

  if (p === "/connectors") {
    return jsonResponse({
      vault: { ready: true, fix: null },
      scopes: ["status:read", "tasks:write", "keys:read", "connectors:read", "connectors:call:read", "connectors:call:write", "connectors:call:personal", "notify:send", "memory:read", "chat:write"],
      connectors: [
        {
          id: "github",
          name: "GitHub",
          category: "code",
          icon: "GH",
          description: "Read issues, pull requests, and workflow runs, or post comments with approval.",
          auth: { kind: "bearer", fields: [{ name: "token", label: "Personal access token", secret: true, required: true }] },
          testMode: "safeRead",
          actions: [
            { id: "list_issues", name: "List issues", description: "Read open issues", risk: "read", dataClass: "public" },
            { id: "create_issue_comment", name: "Comment on issue", description: "Post a comment", risk: "write", dataClass: "public" },
          ],
          connections: [
            { id: "c_demo_gh", connectorId: "github", label: "GitHub (shreyas-tech7)", status: "connected", config: {}, secretNames: ["token"], meta: {}, lastTestAt: MIN_5_AGO, lastTestOk: true, lastTestMs: 142, lastError: null, createdAt: HOUR_2_AGO, updatedAt: MIN_5_AGO },
          ],
        },
        {
          id: "telegram",
          name: "Telegram",
          category: "chat",
          icon: "TG",
          description: "Two-way bot for /status, /tasks, /brief, /chat, and inline approval buttons.",
          auth: { kind: "bot_token", fields: [{ name: "token", label: "Bot token", secret: true, required: true }] },
          testMode: "safeRead",
          actions: [{ id: "send_message", name: "Send message", description: "Send a message to the paired owner chat", risk: "write", dataClass: "Internal" }],
          connections: [
            { id: "c_demo_tg", connectorId: "telegram", label: "Telegram (@titan_runner_bot)", status: "connected", config: {}, secretNames: ["token"], meta: { pairedChatId: "4200001" }, lastTestAt: MIN_5_AGO, lastTestOk: true, lastTestMs: 96, lastError: null, createdAt: HOUR_2_AGO, updatedAt: MIN_5_AGO },
          ],
        },
        {
          id: "hn",
          name: "Hacker News",
          category: "News",
          icon: "HN",
          description: "Read top stories and discussions from Hacker News with no API key.",
          auth: { kind: "none", fields: [] },
          testMode: "safeRead",
          actions: [{ id: "top_stories", name: "Top stories", description: "Fetch top stories", risk: "read", dataClass: "public" }],
          connections: [
            { id: "c_demo_hn", connectorId: "hn", label: "Hacker News", status: "connected", config: {}, secretNames: [], meta: {}, lastTestAt: MIN_20_AGO, lastTestOk: true, lastTestMs: 88, lastError: null, createdAt: HOUR_2_AGO, updatedAt: MIN_20_AGO },
          ],
        },
      ],
    });
  }

  if (p === "/approvals") {
    return jsonResponse({
      approvals: [
        {
          id: "apr_demo_1",
          connectionId: "c_demo_gh",
          connectorId: "github",
          actionId: "create_issue_comment",
          requestedBy: "subagent:sa_demo_2",
          summary: "github.create_issue_comment on shreyas-tech7/TITAN-Runner#12",
          risk: "write",
          dataClass: "public",
          status: "pending",
          createdAt: MIN_20_AGO,
          expiresAt: "2026-10-12T02:40:00.000Z",
          decidedAt: null,
          decidedBy: null,
          error: null,
        },
      ],
    });
  }

  if (p === "/admin/mcp/tokens") {
    return jsonResponse({
      scopes: ["status:read", "tasks:write", "keys:read", "connectors:read", "connectors:call:read", "connectors:call:write", "connectors:call:personal", "notify:send", "memory:read", "chat:write"],
      tokens: [
        { id: "mcpt_demo_1", label: "Claude Code on laptop", clientId: null, kind: "bearer", scopes: ["status:read", "tasks:write", "connectors:read"], createdAt: HOUR_2_AGO, lastUsedAt: MIN_5_AGO, expiresAt: "2027-01-09T00:00:00.000Z", revokedAt: null },
        { id: "mcpt_demo_2", label: "Claude Desktop (OAuth)", clientId: "mcp_client_demo", kind: "oauth", scopes: ["status:read", "chat:write"], createdAt: HOUR_2_AGO, lastUsedAt: MIN_20_AGO, expiresAt: "2026-11-10T00:00:00.000Z", revokedAt: null },
      ],
    });
  }

  if (p === "/admin/notify/rules") {
    return jsonResponse({
      rules: [
        { id: "nr_demo_1", label: "Important alerts", eventPattern: "*", minSeverity: "warn", channels: ["c_demo_tg"], quietHours: "23:00-07:00", tz: "America/Chicago", enabled: true, createdAt: HOUR_2_AGO },
      ],
      deliveries: [
        { id: 1, at: MIN_20_AGO, eventType: "key.proven", channel: "c_demo_tg", status: "sent", error: null },
      ],
    });
  }

  if (p === "/chat/threads") {
    return jsonResponse({
      ready: true,
      providers: [
        { id: "groq", label: "Groq", defaultModel: "llama-3.3-70b-versatile", models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"] },
        { id: "gemini", label: "Google Gemini", defaultModel: "gemini-2.5-flash", models: ["gemini-2.5-flash"] },
      ],
      threads: [
        { id: "thr_demo_1", title: "How does TITAN sealed-box key verification work?", provider: "groq", model: "llama-3.3-70b-versatile", created_at: HOUR_2_AGO, updated_at: MIN_5_AGO },
      ],
    });
  }

  if (p.startsWith("/chat/threads/")) {
    return jsonResponse({
      thread: { id: "thr_demo_1", title: "How does TITAN sealed-box key verification work?", provider: "groq", model: "llama-3.3-70b-versatile", created_at: HOUR_2_AGO, updated_at: MIN_5_AGO },
      messages: [
        { id: 1, role: "user", content: "How does TITAN sealed-box key verification work?", provider: null, model: null, tokens_in: null, tokens_out: null, ms: null, at: HOUR_2_AGO },
        {
          id: 2,
          role: "assistant",
          content: "When you paste a provider key in `/keys`, the Worker:\n\n1. Validates the format and runs a 5-second test call against the provider.\n2. Encrypts the key with GitHub's X25519 public key (`crypto_box_seal`) and uploads it to GitHub Actions Secrets.\n3. Dispatches `.github/workflows/provider-selftest.yml`, which proves the runner can read the secret and posts `/internal/provider-proof`.",
          provider: "groq",
          model: "llama-3.3-70b-versatile",
          tokens_in: 24,
          tokens_out: 78,
          ms: 195,
          at: MIN_5_AGO,
        },
      ],
    });
  }

  if (p === "/schedules") {
    return jsonResponse({
      schedules: [
        {
          id: "sched_daily_brief",
          label: "Daily brief",
          cron: "30 7 * * *",
          tz: "America/Chicago",
          kind: "brief",
          taskType: "auto",
          brief: "Generate and send the daily brief.",
          enabled: true,
          builtIn: true,
          lastRunAt: HOUR_2_AGO,
          nextRunAt: "2026-10-11T12:30:00.000Z",
          nextRuns: ["2026-10-11T12:30:00.000Z", "2026-10-12T12:30:00.000Z", "2026-10-13T12:30:00.000Z"],
          lastStatus: "ok",
          lastError: null,
        },
        {
          id: "sched_demo_arxiv",
          label: "Morning arXiv safety scan",
          cron: "0 8 * * 1-5",
          tz: "America/Chicago",
          kind: "task",
          taskType: "research",
          brief: "Scan cs.AI and cs.LG for alignment and interpretability papers.",
          enabled: true,
          builtIn: false,
          lastRunAt: HOUR_2_AGO,
          nextRunAt: "2026-10-12T13:00:00.000Z",
          nextRuns: ["2026-10-12T13:00:00.000Z", "2026-10-13T13:00:00.000Z", "2026-10-14T13:00:00.000Z"],
          lastStatus: "queued:sa_demo_1",
          lastError: null,
        },
      ],
    });
  }

  if (p === "/brief") {
    return jsonResponse({
      brief: {
        date: "2026-10-11",
        generatedAt: MIN_5_AGO,
        weather: "18°C, wind 11 km/h (clear sky)",
        calendar: ["09:30 Team sync", "14:00 Alignment reading group"],
        tasks: { done: 4, failed: 0, running: 1 },
        pendingApprovals: 1,
        keysNeedingCare: [],
        researchDigest: "Compiled 4 papers on sparse autoencoders and circuit tracing with links and key findings.",
        healthOk: true,
        aiSummary: "All 3 configured providers (Groq, Gemini, OpenRouter) are green, 4 tasks completed in the last 24 hours, and 1 GitHub comment approval is waiting for your review.",
        text: "TITAN daily brief for 2026-10-11\n- Weather: 18°C, wind 11 km/h\n- Calendar: 09:30 Team sync; 14:00 Alignment reading group\n- Tasks (24h): 4 done, 0 failed, 1 active\n- Approvals waiting: 1\n- Keys: all healthy\n- Health checks: all green",
      },
    });
  }

  if (p === "/activity") {
    return jsonResponse({
      items: [
        { id: "deploy:1", kind: "deploy", at: MIN_5_AGO, title: "Worker deployed at commit wave12demo", detail: "Built at 2026-10-11T02:54:00Z", status: "info" },
        { id: "key:3", kind: "key", at: MIN_5_AGO, title: "Key runner_proof: groq (ok)", detail: "Fingerprint demo00000000", status: "ok" },
        { id: "conn:1", kind: "connector", at: MIN_20_AGO, title: "Connector github.list_issues: ok", detail: "Caller: mcp (142 ms)", status: "ok" },
        { id: "approval:1", kind: "approval", at: MIN_20_AGO, title: "Approval pending: github.create_issue_comment on #12", detail: "Asked by subagent:sa_demo_2", status: "pending" },
        { id: "sched:1", kind: "schedule", at: HOUR_2_AGO, title: "Schedule ran: Daily brief", detail: "Cron 30 7 * * *", status: "done" },
        { id: "task:1", kind: "task", at: HOUR_2_AGO, title: "Task done: Compare WebCrypto X25519 sealed-box latency", detail: "WebCrypto completes in 0.14 ms per seal in workerd.", status: "done" },
      ],
    });
  }

  if (p === "/health/full") {
    return jsonResponse({
      overall: "ok",
      generatedAt: NOW,
      checks: [
        { id: "worker", name: "Worker & D1", status: "ok", ms: 4, detail: "4 migrations applied, all tables healthy" },
        { id: "github_pat", name: "GitHub PAT", status: "ok", ms: 82, detail: "Actions Secrets public-key read succeeded" },
        { id: "callback_token", name: "Callback token", status: "ok", ms: 2, detail: "Active token rotated 2 hours ago" },
        { id: "pulse_keeper", name: "Pulse keeper", status: "ok", ms: 3, detail: "Last heartbeat 5 minutes ago" },
        { id: "vault", name: "Connector vault", status: "ok", ms: 1, detail: "CONNECTOR_KEK active (AES-256-GCM)" },
      ],
    });
  }

  if (p === "/admin/setup") {
    return jsonResponse({
      allDone: true,
      steps: [
        { id: "worker", title: "Worker is live", done: true, detail: "Connected to titan-runner-brain" },
        { id: "github_pat", title: "GitHub PAT can write secrets", done: true, detail: "Fine-grained PAT verified" },
        { id: "provider_key", title: "At least one AI key is proven", done: true, detail: "Groq, Gemini, and OpenRouter proven" },
        { id: "callback", title: "Runner callbacks reach the Worker", done: true, detail: "TITAN_CALLBACK_TOKEN active" },
        { id: "notify", title: "A notification channel is connected", done: true, detail: "Telegram connected" },
      ],
    });
  }

  if (p === "/admin/security/signins") {
    return jsonResponse({
      generatedAt: NOW,
      summary: { success: 3, failure: 2, blocked: 0, distinctIps: 2 },
      entries: [
        { id: 5, at: MIN_5_AGO, ip: "203.0.113.10", userAgent: "Demo browser", route: "login", result: "success", reason: "ok" },
        { id: 4, at: MIN_20_AGO, ip: "198.51.100.77", userAgent: "Demo script", route: "login", result: "failure", reason: "wrong_token" },
        { id: 3, at: HOUR_2_AGO, ip: "198.51.100.77", userAgent: "Demo script", route: "login", result: "failure", reason: "wrong_token" },
        { id: 2, at: HOUR_2_AGO, ip: "203.0.113.10", userAgent: "Demo browser", route: "login", result: "success", reason: "ok" },
      ],
    });
  }
  if (p === "/admin/health/urls") return jsonResponse({ urls: ["https://shreyas-tech7.github.io/TITAN-Runner/"] });
  if (p === "/admin/callback") return jsonResponse({ status: "active", createdAt: HOUR_2_AGO, lastPingAt: MIN_5_AGO, lastPingOk: true });
  if (p === "/admin/pulse") return jsonResponse({ paused: false, lastHeartbeatAt: MIN_5_AGO, lastKeeperDispatchAt: null, lateMinutes: 0 });
  if (p === "/system-memory") return jsonResponse({ lessons: [{ id: 1, category: "reliability", lesson: "Always verify provider keys in both the Worker and the GitHub runner.", prompt_injection: "Prefer providers with pulse_ok state.", created_at: HOUR_2_AGO }] });
  if (p === "/geospatial/events") return jsonResponse({ events: [], generatedAt: NOW });
  if (p === "/vms") return jsonResponse({ vms: [], generatedAt: NOW });
  if (p === "/osint/tools") return jsonResponse({ tools: [] });

  return jsonResponse({ ok: true });
}
