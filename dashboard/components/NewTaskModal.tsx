"use client";

import { useMemo, useState } from "react";
import { getToken } from "@/lib/token";
import { createIssue, GitHubApiError, OWNER, REPO } from "@/lib/githubApi";
import { buildIssueBody, TITAN_TASK_LABEL, type Priority, type RoutingHint } from "@/lib/taskYaml";
import { addOptimisticTask } from "@/lib/optimisticTasks";

const PRIORITIES: Priority[] = ["low", "normal", "high"];
const ROUTING_HINTS: RoutingHint[] = ["fast", "cheap", "careful", "any"];

type Phase = "form" | "submitting" | "success" | "fallback" | "error";

export default function NewTaskModal({
  onClose,
  onFiled,
  onOpenSettings,
}: {
  onClose: () => void;
  onFiled: () => void;
  onOpenSettings: () => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<Priority>("normal");
  const [routingHint, setRoutingHint] = useState<RoutingHint>("any");
  const [phase, setPhase] = useState<Phase>("form");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [copyLabel, setCopyLabel] = useState("Copy issue body");
  const [filedUrl, setFiledUrl] = useState<string | null>(null);

  const titleValid = title.trim().length > 0;
  const descriptionValid = description.trim().length > 0;
  const formValid = titleValid && descriptionValid;

  const issueBody = useMemo(
    () => buildIssueBody({ title: title.trim(), description: description.trim(), priority, routingHint }),
    [title, description, priority, routingHint],
  );

  const newIssueUrl = useMemo(() => {
    const params = new URLSearchParams({ labels: TITAN_TASK_LABEL, title: title.trim(), body: issueBody });
    return `https://github.com/${OWNER}/${REPO}/issues/new?${params.toString()}`;
  }, [title, issueBody]);

  async function handleSubmit() {
    if (!formValid) return;
    const token = getToken();

    if (!token) {
      // No silent redirect, ever (task instructions, section 1): show the
      // exact body this would file and let the user finish on GitHub
      // themselves, or go set a token up first.
      setPhase("fallback");
      return;
    }

    setPhase("submitting");
    setErrorMessage(null);
    try {
      const issue = await createIssue(token, title.trim(), issueBody, [TITAN_TASK_LABEL]);
      addOptimisticTask({
        localId: `optimistic-${issue.number}`,
        issueNumber: issue.number,
        issueUrl: issue.html_url,
        title: title.trim(),
        priority,
        routingHint,
        createdAt: new Date().toISOString(),
      });
      setFiledUrl(issue.html_url);
      setPhase("success");
      onFiled();
    } catch (err) {
      setErrorMessage(err instanceof GitHubApiError ? err.message : "Could not reach GitHub. Check your connection and try again.");
      setPhase("error");
    }
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(issueBody);
      setCopyLabel("Copied");
      window.setTimeout(() => setCopyLabel("Copy issue body"), 1500);
    } catch {
      setCopyLabel("Copy failed — select the text below");
    }
  }

  if (phase === "success") {
    return (
      <div className="overlay-scrim" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-body">
            <div className="modal-head">
              <h2 className="modal-title">Task filed</h2>
              <button className="btn btn-quiet" onClick={onClose} aria-label="Close">
                Close
              </button>
            </div>
            <p className="text-muted" style={{ fontSize: 13 }}>
              It appears in the queue now, marked <span className="chip chip-optimistic">queued, waiting for next pulse</span> until the
              next cron tick confirms it — that can take up to 15 minutes.
            </p>
            {filedUrl && (
              <a className="btn" href={filedUrl} target="_blank" rel="noreferrer">
                View issue on GitHub →
              </a>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="overlay-scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-body">
          <div className="modal-head">
            <h2 className="modal-title">New task</h2>
            <button className="btn btn-quiet" onClick={onClose} aria-label="Close">
              Close
            </button>
          </div>

          {phase !== "fallback" ? (
            <>
              <div className="field">
                <label htmlFor="task-title">Title</label>
                <input id="task-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Fix the flaky retry test" autoFocus />
              </div>
              <div className="field">
                <label htmlFor="task-desc">Description</label>
                <textarea
                  id="task-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Describe the task clearly enough to hand to an engineer who has never seen this repo before."
                />
              </div>
              <div className="field">
                <label>Priority</label>
                <div className="segmented" role="group" aria-label="Priority">
                  {PRIORITIES.map((p) => (
                    <button key={p} type="button" aria-pressed={priority === p} onClick={() => setPriority(p)}>
                      {p}
                    </button>
                  ))}
                </div>
              </div>
              <div className="field">
                <label>Routing hint</label>
                <div className="segmented" role="group" aria-label="Routing hint">
                  {ROUTING_HINTS.map((h) => (
                    <button key={h} type="button" aria-pressed={routingHint === h} onClick={() => setRoutingHint(h)}>
                      {h}
                    </button>
                  ))}
                </div>
                <div className="field-hint">Nudges which provider the pulse picks — never overrides a real capability match.</div>
              </div>

              {phase === "error" && errorMessage && (
                <div className="field-error" style={{ marginBottom: 12 }}>
                  {errorMessage}{" "}
                  <button className="btn btn-quiet" style={{ padding: "2px 6px" }} onClick={onOpenSettings}>
                    Check token
                  </button>
                </div>
              )}

              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button className="btn btn-primary" onClick={handleSubmit} disabled={!formValid || phase === "submitting"}>
                  {phase === "submitting" ? "Filing…" : getToken() ? "File task" : "Continue without a token"}
                </button>
                {!getToken() && (
                  <span className="field-hint">No token set — you&apos;ll get the exact issue body to file yourself.</span>
                )}
              </div>
            </>
          ) : (
            <>
              <p className="text-muted" style={{ fontSize: 13 }}>
                No GitHub token is set, so this can&apos;t post the issue for you. Here is the exact body it would
                have sent — copy it, or open a pre-filled issue form on GitHub.
              </p>
              <div className="field">
                <label htmlFor="issue-body-preview">Issue body</label>
                <textarea id="issue-body-preview" readOnly value={issueBody} style={{ minHeight: 220 }} />
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button className="btn" onClick={handleCopy}>
                  {copyLabel}
                </button>
                <a className="btn" href={newIssueUrl} target="_blank" rel="noreferrer">
                  Open pre-filled issue on GitHub →
                </a>
                <button className="btn btn-quiet" onClick={onOpenSettings}>
                  Set up a token instead
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
