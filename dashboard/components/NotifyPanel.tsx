"use client";

/**
 * The notification router (Wave 12, C7). A rule names an event, the channels, the lowest severity, the quiet hours, and a
 * window that drops the same message. An error ignores the quiet hours. A message never holds a secret. Each channel has a
 * "Send test" button, so a person knows that the channel works before an event needs it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/kit";
import {
  applyRulePreset, deleteRule, fetchCatalog, fetchEvents, fetchRules, saveRule, sendChannelTest,
  type ConnectionView, type EventRow, type NotifyRule,
} from "@/lib/connectorsApi";
import { CHANNEL_CONNECTORS, RULE_PATTERNS, SEVERITY_LABEL, describeRule } from "@/lib/connectorsView";
import { relative } from "@/lib/time";
import { WorkerApiError } from "@/lib/workerApi";

interface Channel extends ConnectionView {
  connectorName: string;
}

const SEVERITIES = ["info", "warn", "error"] as const;

export default function NotifyPanel({ token, onUnauthorized }: { token: string; onUnauthorized: () => void }) {
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [rules, setRules] = useState<NotifyRule[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState({ label: "", eventPattern: "task.failed", minSeverity: "info" as (typeof SEVERITIES)[number], quietStart: "", quietEnd: "", tz: "America/Chicago", dedupeMinutes: "30", connectionIds: [] as string[] });
  const [problem, setProblem] = useState<string | null>(null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const [catalog, ruleList, eventList] = await Promise.all([fetchCatalog(token), fetchRules(token), fetchEvents(token, 15)]);
      if (!alive.current) return;
      setChannels(catalog.connectors.filter((c) => CHANNEL_CONNECTORS.includes(c.id)).flatMap((c) => c.connections.map((x) => ({ ...x, connectorName: c.name }))));
      setRules(ruleList.rules);
      setEvents(eventList.events);
      setError(null);
    } catch (err) {
      if (err instanceof WorkerApiError && err.status === 401) onUnauthorized();
      else if (alive.current) setError(err instanceof Error ? err.message : "Could not read the notification rules.");
    }
  }, [token, onUnauthorized]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  async function run(name: string, fn: () => Promise<void>) {
    setBusy(name);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      if (err instanceof WorkerApiError && err.status === 401) onUnauthorized();
      else setNotice(err instanceof Error ? err.message : "The request failed.");
    }
    setBusy(null);
  }

  const labelOf = (id: string) => channels?.find((c) => c.id === id)?.label ?? id;

  function addRule() {
    if (form.connectionIds.length === 0) return setProblem("Choose at least one channel.");
    if ((form.quietStart && !form.quietEnd) || (!form.quietStart && form.quietEnd)) return setProblem("Set both the quiet start and the quiet end, or neither.");
    const dedupe = Number(form.dedupeMinutes);
    if (!Number.isInteger(dedupe) || dedupe < 0 || dedupe > 1440) return setProblem("The window must be a whole number from 0 to 1440 minutes.");
    setProblem(null);
    void run("rule", async () => {
      await saveRule(token, {
        label: form.label.trim() || form.eventPattern,
        eventPattern: form.eventPattern,
        minSeverity: form.minSeverity,
        connectionIds: form.connectionIds,
        quietStart: form.quietStart || null,
        quietEnd: form.quietEnd || null,
        tz: form.tz.trim() || "America/Chicago",
        dedupeMinutes: dedupe,
      });
      setForm((f) => ({ ...f, label: "" }));
      await load();
    });
  }

  return (
    <div aria-live="polite">
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      {channels === null && !error ? <p className="e-dim" role="status">Loading the channels</p> : null}
      {notice ? <p className="e-hint" role="status">{notice}</p> : null}

      <h3 className="guide-title">Channels</h3>
      {channels !== null && channels.length === 0 ? (
        <p className="e-dim">No channel yet. Connect Telegram, Discord, Slack, ntfy, or an outbound webhook on the Tools tab. Then come back to set the rules.</p>
      ) : null}
      <ul className="e-list" aria-label="Notification channels">
        {(channels ?? []).map((c) => (
          <li className="e-item" key={c.id} data-channel={c.id}>
            <div className="e-item-head">
              <span className="e-item-title">{c.label}</span>
              <Badge tone="neutral">{c.connectorName}</Badge>
              <Badge tone={c.status === "connected" ? "ok" : "warn"}>{c.status === "connected" ? "Connected" : "Needs a look"}</Badge>
            </div>
            <div className="modal-actions" style={{ marginTop: 4 }}>
              <button
                className="btn"
                disabled={busy !== null}
                onClick={() => void run(`test-${c.id}`, async () => { const out = await sendChannelTest(token, c.id); setNotice(out.ok ? `The test message went to ${c.label}.` : `The test failed for ${c.label}. ${out.error ?? ""}`); })}
              >
                {busy === `test-${c.id}` ? "Sending" : "Send test"}
              </button>
              <button
                className="btn btn-quiet"
                disabled={busy !== null}
                onClick={() => void run(`preset-${c.id}`, async () => { const out = await applyRulePreset(token, c.id); setNotice(out.made.length > 0 ? `Added ${out.made.length} default rule${out.made.length === 1 ? "" : "s"} for ${c.label}.` : `${c.label} already has the default rules.`); await load(); })}
              >
                Add default rules
              </button>
            </div>
          </li>
        ))}
      </ul>

      <h3 className="guide-title" style={{ marginTop: 20 }}>Rules</h3>
      {rules.length === 0 ? <p className="e-dim">No rule yet. With no rule, TITAN sends nothing. Use Add default rules on a channel for a good start.</p> : null}
      {rules.length > 0 ? (
        <table className="keys-table">
          <caption className="sr-only">Notification rules</caption>
          <thead>
            <tr><th scope="col">Rule</th><th scope="col">Channels</th><th scope="col">Details</th><th scope="col">On</th><th scope="col">Actions</th></tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id} data-rule={r.id}>
                <td data-label="Rule"><strong>{r.label}</strong></td>
                <td data-label="Channels">{r.connectionIds.map(labelOf).join(", ")}</td>
                <td data-label="Details" className="e-dim">{describeRule(r)}</td>
                <td data-label="On">
                  <label className="check-row" htmlFor={`on-${r.id}`}>
                    <input id={`on-${r.id}`} type="checkbox" checked={r.enabled} disabled={busy !== null} onChange={() => void run("toggle", async () => { await saveRule(token, { ...r, enabled: !r.enabled }); await load(); })} />
                    <span className="sr-only">Rule {r.label} is on</span>
                  </label>
                </td>
                <td data-label="Actions" className="keys-actions">
                  <button className="btn btn-quiet" disabled={busy !== null} onClick={() => void run("delete", async () => { await deleteRule(token, r.id); await load(); })}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      <details className="try-it" style={{ marginTop: 12 }}>
        <summary>Add a rule</summary>
        <div className="field">
          <label htmlFor="rule-label">Name (optional)</label>
          <input id="rule-label" type="text" maxLength={60} value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} />
        </div>
        <div className="field">
          <label htmlFor="rule-event">Event</label>
          <select id="rule-event" value={form.eventPattern} onChange={(e) => setForm((f) => ({ ...f, eventPattern: e.target.value }))}>
            {RULE_PATTERNS.map((p) => (
              <option key={p} value={p}>{p === "*" ? "* (every event)" : p}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="rule-severity">Lowest severity</label>
          <select id="rule-severity" value={form.minSeverity} onChange={(e) => setForm((f) => ({ ...f, minSeverity: e.target.value as (typeof SEVERITIES)[number] }))}>
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>{SEVERITY_LABEL[s]}</option>
            ))}
          </select>
        </div>
        <fieldset className="field scope-set">
          <legend>Channels</legend>
          {(channels ?? []).map((c) => (
            <label className="check-row" key={c.id} htmlFor={`rule-ch-${c.id}`}>
              <input id={`rule-ch-${c.id}`} type="checkbox" checked={form.connectionIds.includes(c.id)} onChange={() => setForm((f) => ({ ...f, connectionIds: f.connectionIds.includes(c.id) ? f.connectionIds.filter((x) => x !== c.id) : [...f.connectionIds, c.id] }))} />
              {c.label}
            </label>
          ))}
        </fieldset>
        <div className="field">
          <label htmlFor="rule-qs">Quiet hours start (optional)</label>
          <input id="rule-qs" type="time" value={form.quietStart} onChange={(e) => setForm((f) => ({ ...f, quietStart: e.target.value }))} />
        </div>
        <div className="field">
          <label htmlFor="rule-qe">Quiet hours end (optional)</label>
          <input id="rule-qe" type="time" value={form.quietEnd} onChange={(e) => setForm((f) => ({ ...f, quietEnd: e.target.value }))} />
          <div className="field-hint">An error still goes out during quiet hours.</div>
        </div>
        <div className="field">
          <label htmlFor="rule-tz">Time zone</label>
          <input id="rule-tz" type="text" autoComplete="off" value={form.tz} onChange={(e) => setForm((f) => ({ ...f, tz: e.target.value }))} />
        </div>
        <div className="field">
          <label htmlFor="rule-dedupe">Drop the same message for (minutes)</label>
          <input id="rule-dedupe" type="text" inputMode="numeric" value={form.dedupeMinutes} onChange={(e) => setForm((f) => ({ ...f, dedupeMinutes: e.target.value }))} />
        </div>
        {problem ? <p className="field-error" role="alert">{problem}</p> : null}
        <button className="btn btn-primary" disabled={busy !== null} onClick={addRule}>Add rule</button>
      </details>

      <h3 className="guide-title" style={{ marginTop: 20 }}>Recent events</h3>
      {events.length === 0 ? <p className="e-dim">No event yet.</p> : null}
      <ul className="e-list" aria-label="Recent events">
        {events.map((e) => (
          <li className="e-item" key={e.id}>
            <div className="e-item-head">
              <Badge tone={e.severity === "error" ? "danger" : e.severity === "warn" ? "warn" : "neutral"}>{e.severity}</Badge>
              <span className="e-item-title">{e.title}</span>
              <span className="e-dim e-num">{e.type} · {relative(e.at)}</span>
            </div>
            {e.body ? <div className="e-dim">{e.body}</div> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
