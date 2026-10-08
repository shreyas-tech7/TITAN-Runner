"use client";

/** /connectors is the Connectors page. See components/ConnectorsPage.tsx. */
import ConnectorsPage from "@/components/ConnectorsPage";
import PageShell from "@/components/PageShell";

export default function Page() {
  return (
    <PageShell active="connectors" title="Connectors" subtitle="Link TITAN to your tools, and let your tools use TITAN">
      {(token, lock) => <ConnectorsPage token={token} onUnauthorized={lock} />}
    </PageShell>
  );
}
