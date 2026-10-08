"use client";

/** /keys is the Keys page. See components/KeysPage.tsx. */
import KeysPage from "@/components/KeysPage";
import PageShell from "@/components/PageShell";

export default function Page() {
  return (
    <PageShell active="keys" title="Keys" subtitle="Provider keys: save, check, and prove them">
      {(token, lock) => <KeysPage token={token} onUnauthorized={lock} />}
    </PageShell>
  );
}
