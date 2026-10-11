"use client";

import { OWNER, REPO } from "@/lib/githubApi";

const WORKFLOW_URL = `https://github.com/${OWNER}/${REPO}/actions/workflows/vault-provision.yml`;

/**
 * The setup card for the vault (Wave 12, C2). The vault holds connector secrets and chat keys, encrypted with a key that a
 * GitHub runner makes. No person sees that key. Without it, the Worker answers 503 "vault_not_ready".
 */
export default function VaultCard({ fix }: { fix: string | null }) {
  return (
    <div className="banner" role="status" aria-label="Vault setup">
      <span>
        <strong>The vault is not ready.</strong>{" "}
        <span className="text-muted">
          Connectors that need a secret, and instant chat, wait for it. {fix ?? ""}
        </span>
        <ol className="guide-list" style={{ marginTop: 8 }}>
          <li>Open the workflow on GitHub.</li>
          <li>Choose Run workflow, then Run workflow again.</li>
          <li>Wait for the green check. Then refresh this page.</li>
        </ol>
      </span>
      <a className="btn btn-quiet" href={WORKFLOW_URL} target="_blank" rel="noopener noreferrer">Open the workflow</a>
    </div>
  );
}
