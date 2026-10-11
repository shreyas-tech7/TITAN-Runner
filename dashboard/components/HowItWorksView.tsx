"use client";

import { Badge, Panel } from "@/components/kit";

export default function HowItWorksView() {
  return (
    <div className="bento-grid">
      <Panel title="1. Three-Plane Architecture" eyebrow="System overview" tone="ion">
        <p className="e-dim">
          TITAN-Runner runs on free tiers only ($0 per month). It splits work across three planes so each plane does
          what it is best at:
        </p>
        <ul className="guide-list">
          <li>
            <strong>Dashboard (GitHub Pages): </strong>A static Next.js export. It holds no secrets in its build output
            and talks to the Worker with your admin token (<span className="e-num">X-Titan-Auth</span>) or shows sample
            data in <span className="e-num">?demo=1</span> mode.
          </li>
          <li>
            <strong>Brain Worker &amp; D1 (Cloudflare Workers): </strong>Handles instant chat (<span className="e-num">POST /chat</span>),
            key verification and sealing, the 15-connector broker, the MCP server (<span className="e-num">POST /mcp</span>),
            schedules, the daily brief, and the pulse keeper cron.
          </li>
          <li>
            <strong>Compute Plane (GitHub Actions): </strong>Runs the 15-minute autonomous pulse (<span className="e-num">pulse.yml</span>),
            isolated sub-agent tasks (<span className="e-num">subagent.yml</span>), and key self-tests (<span className="e-num">provider-selftest.yml</span>).
          </li>
        </ul>
      </Panel>

      <Panel title="2. Keys That Work (4-State Proof)" eyebrow="Cryptographic key pipeline" tone="plasma">
        <p className="e-dim">
          When you paste a provider key on <span className="e-num">/keys</span>, TITAN proves the key at every hop
          before marking it green:
        </p>
        <ol className="guide-list">
          <li>
            <Badge tone="neutral">1. Unconfigured</Badge> — No key has been saved for this provider yet.
          </li>
          <li>
            <Badge tone="corona">2. Worker verified</Badge> — The Worker makes a real 5-second test call to the provider,
            seals the key with GitHub&apos;s X25519 public key (<span className="e-num">crypto_box_seal</span> in WebCrypto),
            and uploads it to GitHub Actions Secrets.
          </li>
          <li>
            <Badge tone="ok">3. Runner proven</Badge> — The Worker dispatches <span className="e-num">provider-selftest.yml</span>.
            The GitHub runner reads the secret from its environment, calls the provider, and posts a signed proof to{" "}
            <span className="e-num">/internal/provider-proof</span>.
          </li>
          <li>
            <Badge tone="ok">4. Pulse OK</Badge> — A scheduled pulse uses the key and records a healthy heartbeat.
          </li>
        </ol>
      </Panel>

      <Panel title="3. Connector Broker & Personal-Data Wall" eyebrow="15 built-in connectors" tone="corona">
        <p className="e-dim">
          Connector credentials live in the Worker&apos;s AES-256-GCM vault (<span className="e-num">vault_records</span>),
          bound to the connection ID and connector ID via Additional Authenticated Data (AAD). The browser and sub-agents
          never receive raw connector tokens.
        </p>
        <ul className="guide-list">
          <li>
            <strong>Read actions: </strong>Run immediately when allowed by policy and rate limits.
          </li>
          <li>
            <strong>Write actions: </strong>Create a pending approval row in D1 and send interactive Approve/Deny buttons
            to Telegram and the Approvals panel.
          </li>
          <li>
            <strong>Personal-data wall: </strong>Connectors marked <span className="e-num">Personal</span> (such as Gmail,
            Google Calendar, Notion, and Google Drive) cannot be called by autonomous sub-agents on this public repository,
            and outputs are scrubbed before any commit to <span className="e-num">state/</span>.
          </li>
        </ul>
      </Panel>

      <Panel title="4. Dual-Era MCP Server & OAuth 2.1" eyebrow="Claude Code & Claude app" tone="ion">
        <p className="e-dim">
          The Worker exposes <span className="e-num">POST /mcp</span> speaking both MCP protocol eras (<span className="e-num">2024-11-05</span> and{" "}
          <span className="e-num">2025-11-25</span>). You can connect with a scoped Bearer token in Claude Code or use
          OAuth 2.1 with PKCE (<span className="e-num">S256</span>) for the Claude app.
        </p>
      </Panel>
    </div>
  );
}
