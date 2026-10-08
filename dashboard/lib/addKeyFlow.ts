/**
 * The steps of the "Save and verify" flow (Wave 12, K7). The Worker does the format check, the provider check, the seal,
 * and the GitHub write in one request. The runner test comes later. The dashboard polls `GET /admin/keys` every 5 seconds
 * for up to 3 minutes to see the proof. This file holds the pure rules, so a test can check them without a browser.
 */
import type { KeyRow } from "./keysApi";

export const POLL_INTERVAL_MS = 5_000;
export const POLL_LIMIT_MS = 180_000;
const SLACK_MS = 120_000;

export type StepId = "format" | "provider" | "seal" | "github" | "runner";
export type StepStatus = "pending" | "active" | "done" | "failed" | "skipped";

export type FlowPhase =
  | { name: "form" }
  | { name: "sending" }
  | { name: "rejected"; reason: string }
  | { name: "confirm"; reason: string }
  | { name: "failed"; message: string; permission: string | null }
  | { name: "saved"; verified: boolean }
  | { name: "proven" }
  | { name: "proof_failed"; reason: string }
  | { name: "proof_timeout" };

export const STEP_LABELS: Record<StepId, string> = {
  format: "Format of the key",
  provider: "Check with the provider",
  seal: "Seal the key",
  github: "Save the secret on GitHub",
  runner: "Test in a runner",
};

const ORDER: StepId[] = ["format", "provider", "seal", "github", "runner"];

/** The status of each step for a phase. */
export function stepsFor(phase: FlowPhase): Array<{ id: StepId; label: string; status: StepStatus }> {
  const status: Record<StepId, StepStatus> = { format: "pending", provider: "pending", seal: "pending", github: "pending", runner: "pending" };
  switch (phase.name) {
    case "form":
      break;
    case "sending":
      status.format = "done";
      status.provider = "active";
      break;
    case "rejected":
      status.format = "done";
      status.provider = "failed";
      status.seal = status.github = status.runner = "skipped";
      break;
    case "confirm":
      status.format = "done";
      status.provider = "failed";
      status.seal = status.github = status.runner = "pending";
      break;
    case "failed":
      status.format = status.provider = "done";
      status.seal = "done";
      status.github = "failed";
      status.runner = "skipped";
      break;
    case "saved":
      status.format = status.provider = status.seal = status.github = "done";
      if (!phase.verified) status.provider = "skipped";
      status.runner = "active";
      break;
    case "proven":
      status.format = status.provider = status.seal = status.github = status.runner = "done";
      break;
    case "proof_failed":
      status.format = status.provider = status.seal = status.github = "done";
      status.runner = "failed";
      break;
    case "proof_timeout":
      status.format = status.provider = status.seal = status.github = "done";
      status.runner = "pending";
      break;
  }
  return ORDER.map((id) => ({ id, label: STEP_LABELS[id], status: status[id] }));
}

/**
 * Read the key row after a save. The proof counts only if it is newer than the start of this flow.
 * @returns "proven" when a runner or the pulse passed, "failed" when the proof failed or the provider rejects the key, "pending" otherwise.
 */
export function proofOutcome(row: Pick<KeyRow, "runnerProof" | "state"> | undefined, startedAtMs: number): { outcome: "pending" | "proven" | "failed"; reason: string } {
  if (!row) return { outcome: "pending", reason: "" };
  const proof = row.runnerProof;
  const fresh = proof && Date.parse(proof.at) >= startedAtMs - SLACK_MS;
  if (fresh && proof.result === "ok") return { outcome: "proven", reason: "" };
  if (fresh && proof.result === "failed") return { outcome: "failed", reason: proof.detail ?? "The runner test failed." };
  if (row.state === "invalid") return { outcome: "failed", reason: "The provider rejects this key." };
  return { outcome: "pending", reason: "" };
}

/** What to do after `elapsedMs` of polling. */
export function nextPollAction(elapsedMs: number): "poll" | "timeout" {
  return elapsedMs >= POLL_LIMIT_MS ? "timeout" : "poll";
}

/** The summary line that a phase shows under the steps. */
export function phaseMessage(phase: FlowPhase): string {
  switch (phase.name) {
    case "rejected":
      return `The provider rejected this key. ${phase.reason} Nothing was saved.`;
    case "confirm":
      return `The provider did not answer. ${phase.reason} Save anyway?`;
    case "failed":
      return phase.message;
    case "saved":
      return phase.verified ? "The key is saved and the provider accepted it. A runner is testing it now." : "The key is saved. It is not verified yet. A runner is testing it now.";
    case "proven":
      return "A runner used this key with success.";
    case "proof_failed":
      return `The runner test failed. ${phase.reason}`;
    case "proof_timeout":
      return "The runner test takes longer than 3 minutes. The key stays saved and not verified. Close this window and use Test now later.";
    default:
      return "";
  }
}
