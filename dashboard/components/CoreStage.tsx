"use client";

/**
 * The center stage of the home screen: the AI core, a greeting with the state of the work, and the chat. The
 * assistant is the focus. Everything else sits in the Systems Deck below.
 */
import AiCore from "@/components/AiCore";
import ChatPage from "@/components/ChatPage";
import { CORE_STATE_LABEL, coreHour, greetingFor, taskSummary, type CoreState } from "@/lib/core";
import useClock from "@/lib/useClock";
import type { TaskRecord } from "@/lib/types";

export default function CoreStage({
  state,
  tasks,
  token,
  onUnauthorized,
  onStreamingChange,
}: {
  state: CoreState;
  tasks: TaskRecord[];
  token: string;
  onUnauthorized: () => void;
  onStreamingChange: (streaming: boolean) => void;
}) {
  const now = useClock();
  // Before the clock mounts, the greeting is neutral, so the server page and the first client page agree.
  const greeting = now ? greetingFor(coreHour(now)) : "Hello";
  return (
    <section className="core-stage" aria-label="TITAN core">
      <AiCore state={state} />
      <p className="core-state mono">Core {CORE_STATE_LABEL[state]}</p>
      <h2 className="core-greeting">
        {greeting}, operator. <span className="core-greeting-sub">{taskSummary(tasks)}</span>
      </h2>
      <div className="core-chat">
        <ChatPage token={token} onUnauthorized={onUnauthorized} compact onStreamingChange={onStreamingChange} />
      </div>
    </section>
  );
}
