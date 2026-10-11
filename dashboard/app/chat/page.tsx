"use client";

import PageShell from "@/components/PageShell";
import ChatPage from "@/components/ChatPage";

export default function ChatRoute() {
  return (
    <PageShell
      active="chat"
      title="Instant Chat"
      subtitle="Two-second streaming replies from your free provider keys, with automatic failover"
    >
      {(token, lock) => <ChatPage token={token} onUnauthorized={lock} />}
    </PageShell>
  );
}
