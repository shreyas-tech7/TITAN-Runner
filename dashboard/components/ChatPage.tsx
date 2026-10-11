"use client";

/**
 * Instant chat page (Wave 12, A1 and X21).
 *
 * Streams tokens from the Worker (`POST /chat` SSE) using provider keys marked with `alsoForChat: true` in the encrypted
 * vault. If the chosen provider returns 429 or 5xx before the first token, the Worker automatically fails over to the next
 * chat provider. Any assistant reply can be turned into a background sub-agent task with one click.
 */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import CopyButton from "@/components/CopyButton";
import { Badge, Panel } from "@/components/kit";
import { relative } from "@/lib/time";
import {
  callWorker,
  clearChatHistory,
  deleteChatThread,
  fetchChatThread,
  fetchChatThreads,
  isWorkerConfigured,
  queueTask,
  saveChatProviderOrder,
  WorkerApiError,
  type ChatMessageRow,
  type ChatProviderOption,
  type ChatThreadSummary,
} from "@/lib/workerApi";

/** Lightweight, safe Markdown-like renderer for paragraphs, code blocks, lists, and inline code. */
function RenderMarkdown({ text }: { text: string }) {
  const blocks = String(text || "").split(/```([\s\S]*?)```/g);
  return (
    <div className="chat-markdown">
      {blocks.map((part, idx) => {
        if (idx % 2 === 1) {
          const firstNewline = part.indexOf("\n");
          const code = firstNewline >= 0 ? part.slice(firstNewline + 1) : part;
          return (
            <pre key={idx} className="result-box" tabIndex={0}>
              <code>{code}</code>
            </pre>
          );
        }
        const paragraphs = part
          .split(/\n{2,}/)
          .map((p) => p.trim())
          .filter(Boolean);
        return paragraphs.map((para, pIdx) => {
          const lines = para.split("\n");
          if (lines.every((l) => /^[-*]\s+/.test(l.trim()))) {
            return (
              <ul key={`${idx}-${pIdx}`} className="guide-list">
                {lines.map((l, lIdx) => (
                  <li key={lIdx}>{l.replace(/^[-*]\s+/, "")}</li>
                ))}
              </ul>
            );
          }
          return (
            <p key={`${idx}-${pIdx}`} style={{ margin: "6px 0", whiteSpace: "pre-wrap" }}>
              {para}
            </p>
          );
        });
      })}
    </div>
  );
}

export default function ChatPage({ token, onUnauthorized }: { token: string; onUnauthorized: () => void }) {
  const [ready, setReady] = useState<boolean | null>(null);
  const [providers, setProviders] = useState<ChatProviderOption[]>([]);
  const [threads, setThreads] = useState<ChatThreadSummary[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessageRow[]>([]);
  const [provider, setProvider] = useState<string>("auto");
  const [model, setModel] = useState<string>("");
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const alive = useRef(true);

  const loadThreads = useCallback(async () => {
    try {
      const out = await fetchChatThreads(token);
      if (!alive.current) return;
      setReady(out.ready);
      setProviders(out.providers);
      setThreads(out.threads);
      setError(null);
    } catch (err) {
      if (err instanceof WorkerApiError && err.status === 401) onUnauthorized();
      else if (alive.current) setError(err instanceof Error ? err.message : "Could not load chat threads.");
    }
  }, [token, onUnauthorized]);

  const selectThread = useCallback(
    async (threadId: string) => {
      setActiveThreadId(threadId);
      try {
        const out = await fetchChatThread(token, threadId);
        if (alive.current) setMessages(out.messages);
      } catch (err) {
        if (err instanceof WorkerApiError && err.status === 401) onUnauthorized();
        else if (alive.current) setError(err instanceof Error ? err.message : "Could not load the thread.");
      }
    },
    [token, onUnauthorized],
  );

  useEffect(() => {
    alive.current = true;
    void loadThreads();
    return () => {
      alive.current = false;
      abortRef.current?.abort();
    };
  }, [loadThreads]);

  async function sendMessage() {
    const text = draft.trim();
    if (!text || streaming) return;
    setDraft("");
    setError(null);
    setNotice(null);

    const userMsg: ChatMessageRow = {
      id: Date.now(),
      role: "user",
      content: text,
      provider: null,
      model: null,
      tokens_in: null,
      tokens_out: null,
      ms: null,
      at: new Date().toISOString(),
    };
    const assistantId = Date.now() + 1;
    const placeholder: ChatMessageRow = {
      id: assistantId,
      role: "assistant",
      content: "",
      provider: provider === "auto" ? null : provider,
      model: model || null,
      tokens_in: null,
      tokens_out: null,
      ms: null,
      at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg, placeholder]);
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await callWorker("/chat", token, {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({
          message: text,
          ...(activeThreadId ? { threadId: activeThreadId } : {}),
          ...(provider !== "auto" ? { provider } : {}),
          ...(model ? { model } : {}),
        }),
      });

      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Chat failed (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) >= 0) {
          const rawEvent = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          let eventName = "message";
          let dataLine = "";
          for (const line of rawEvent.split("\n")) {
            if (line.startsWith("event:")) eventName = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLine += line.slice(5).trim();
          }
          if (!dataLine) continue;
          try {
            const parsed = JSON.parse(dataLine);
            if (eventName === "meta") {
              if (parsed.threadId) setActiveThreadId(parsed.threadId);
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId ? { ...m, provider: parsed.provider ?? m.provider, model: parsed.model ?? m.model } : m,
                ),
              );
            } else if (eventName === "delta" && typeof parsed.text === "string") {
              setMessages((prev) =>
                prev.map((m) => (m.id === assistantId ? { ...m, content: m.content + parsed.text } : m)),
              );
            } else if (eventName === "done") {
              if (parsed.threadId) setActiveThreadId(parsed.threadId);
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? {
                        ...m,
                        provider: parsed.provider ?? m.provider,
                        model: parsed.model ?? m.model,
                        tokens_in: parsed.tokensIn ?? null,
                        tokens_out: parsed.tokensOut ?? null,
                        ms: parsed.ms ?? null,
                      }
                    : m,
                ),
              );
            } else if (eventName === "error") {
              setError(parsed.message || "Stream ended with an error.");
            }
          } catch {
            // ignore malformed event line
          }
        }
      }
      await loadThreads();
    } catch (err) {
      if ((err as Error)?.name !== "AbortError") {
        setError(err instanceof Error ? err.message : "Chat request failed.");
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  function stopStream() {
    abortRef.current?.abort();
    setStreaming(false);
  }

  async function handleMakeTask(content: string) {
    try {
      const brief = content.slice(0, 1500);
      const out = await queueTask(token, "auto", brief);
      setNotice(`Queued sub-agent task ${out.id}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not queue the task.");
    }
  }

  async function handleDeleteThread(id: string) {
    try {
      await deleteChatThread(token, id);
      if (activeThreadId === id) {
        setActiveThreadId(null);
        setMessages([]);
      }
      await loadThreads();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete the thread.");
    }
  }

  async function handleClearAll() {
    try {
      await clearChatHistory(token);
      setActiveThreadId(null);
      setMessages([]);
      setNotice("Cleared all chat history.");
      await loadThreads();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not clear chat history.");
    }
  }

  async function moveProvider(idx: number, dir: -1 | 1) {
    const next = [...providers];
    const target = idx + dir;
    if (target < 0 || target >= next.length) return;
    const [picked] = next.splice(idx, 1);
    next.splice(target, 0, picked);
    setProviders(next);
    try {
      await saveChatProviderOrder(
        token,
        next.map((p) => p.id),
      );
      setNotice("Saved chat failover order.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save provider order.");
    }
  }

  if (!isWorkerConfigured()) {
    return (
      <Panel title="Instant Chat" eyebrow="Assistant" tone="ion">
        <p className="e-dim">
          The Worker is not configured for this build. Set <span className="e-num">TITAN_WORKER_URL</span> and rebuild the
          site. See docs/RUNTIME.md.
        </p>
      </Panel>
    );
  }

  if (ready === false) {
    return (
      <Panel title="Instant Chat" eyebrow="Assistant" tone="corona" data-testid="chat-empty-key-card">
        <p className="e-hint">
          <strong>No chat key is stored in the Worker vault yet. </strong>
          Instant chat runs directly in the Worker so you get a reply in under two seconds instead of waiting for a GitHub
          Actions runner.
        </p>
        <p className="e-dim">
          Open the Keys page, paste a free Groq, Gemini, OpenRouter, or Cerebras key, and tick{" "}
          <strong>Also use for instant chat</strong>.
        </p>
        <div className="modal-actions" style={{ marginTop: 12 }}>
          <Link className="btn btn-primary" href="/keys">
            Open Keys page
          </Link>
        </div>
      </Panel>
    );
  }

  const chosenProviderObj = providers.find((p) => p.id === provider);
  const modelChoices = chosenProviderObj?.models ?? [];

  return (
    <div className="bento-grid">
      <Panel
        title="Conversations"
        eyebrow="History"
        tone="plasma"
        actions={
          <>
            <button
              className="btn btn-primary"
              onClick={() => {
                setActiveThreadId(null);
                setMessages([]);
                setNotice(null);
              }}
            >
              + New chat
            </button>
            {threads.length > 0 ? (
              <button className="btn btn-quiet" onClick={() => void handleClearAll()}>
                Clear all
              </button>
            ) : null}
          </>
        }
      >
        {threads.length === 0 ? <p className="e-dim">No saved threads yet. Send a message to start one.</p> : null}
        <ul className="e-list" aria-label="Chat threads">
          {threads.map((t) => (
            <li className="e-item" key={t.id} data-thread={t.id}>
              <div className="e-item-head">
                <button
                  className="btn btn-quiet"
                  style={{ textAlign: "left", fontWeight: activeThreadId === t.id ? 700 : 400 }}
                  onClick={() => void selectThread(t.id)}
                >
                  {t.title}
                </button>
                {t.provider ? <Badge tone="neutral">{t.provider}</Badge> : null}
                <span className="e-dim e-num">{relative(t.updated_at)}</span>
                <button className="btn btn-quiet" aria-label={`Delete ${t.title}`} onClick={() => void handleDeleteThread(t.id)}>
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>

        {providers.length > 1 ? (
          <section aria-label="Failover order" style={{ marginTop: 16 }}>
            <h3 className="guide-title">Failover order</h3>
            <p className="e-dim">When Provider is set to Auto, TITAN tries these chat providers in order.</p>
            <ul className="e-list">
              {providers.map((p, idx) => (
                <li className="e-item" key={p.id}>
                  <div className="e-item-head">
                    <span className="e-num">{idx + 1}.</span>
                    <span className="e-item-title">{p.label}</span>
                    <span className="e-dim e-num">{p.defaultModel}</span>
                    <button className="btn btn-quiet" disabled={idx === 0} onClick={() => void moveProvider(idx, -1)}>
                      Up
                    </button>
                    <button
                      className="btn btn-quiet"
                      disabled={idx === providers.length - 1}
                      onClick={() => void moveProvider(idx, 1)}
                    >
                      Down
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </Panel>

      <Panel title="Instant Chat" eyebrow="Streamed from Worker" tone="ion">
        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className="e-hint" role="status">
            {notice}
          </p>
        ) : null}

        <div className="e-pair" style={{ marginBottom: 12 }}>
          <div className="field">
            <label htmlFor="chat-provider">Provider</label>
            <select
              id="chat-provider"
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value);
                setModel("");
              }}
            >
              <option value="auto">Auto (failover)</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="chat-model">Model</label>
            <select id="chat-model" value={model} onChange={(e) => setModel(e.target.value)} disabled={provider === "auto"}>
              <option value="">Default model</option>
              {modelChoices.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div aria-live="polite" aria-label="Messages" style={{ minHeight: 220, marginBottom: 12 }}>
          {messages.length === 0 ? (
            <p className="e-dim">Ask a question or draft a task brief. Replies stream directly from the Worker.</p>
          ) : null}
          <ul className="e-list">
            {messages.map((m) => (
              <li className="e-item" key={m.id} data-role={m.role}>
                <div className="e-item-head">
                  <Badge tone={m.role === "user" ? "corona" : "ok"}>{m.role === "user" ? "You" : "TITAN"}</Badge>
                  {m.provider ? <Badge tone="neutral">{m.provider}</Badge> : null}
                  {m.model ? <span className="e-dim e-num">{m.model}</span> : null}
                  {m.tokens_out != null ? <span className="e-dim e-num">{m.tokens_out} tok</span> : null}
                  {m.ms != null ? <span className="e-dim e-num">{m.ms} ms</span> : null}
                </div>
                <RenderMarkdown text={m.content} />
                {m.role === "assistant" && m.content ? (
                  <div className="modal-actions" style={{ marginTop: 6 }}>
                    <CopyButton text={m.content} what="the reply" label="Copy" />
                    <button className="btn btn-quiet" onClick={() => void handleMakeTask(m.content)}>
                      Make this a task
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </div>

        <div className="field">
          <label htmlFor="chat-input">Message</label>
          <textarea
            id="chat-input"
            rows={3}
            placeholder="Ask TITAN anything… (Ctrl+Enter or Cmd+Enter to send)"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                void sendMessage();
              }
            }}
          />
        </div>
        <div className="modal-actions">
          <button className="btn btn-primary" disabled={!draft.trim() || streaming} onClick={() => void sendMessage()}>
            {streaming ? "Streaming…" : "Send"}
          </button>
          {streaming ? (
            <button className="btn btn-danger" onClick={stopStream}>
              Stop
            </button>
          ) : null}
        </div>
      </Panel>
    </div>
  );
}
