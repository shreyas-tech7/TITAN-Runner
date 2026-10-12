"use client";

/** /ops shows the ops panels. See components/OpsPage.tsx. */
import OpsPage from "@/components/OpsPage";
import PageShell from "@/components/PageShell";

export default function Page() {
  return (
    <PageShell active="ops" title="Ops" subtitle="Provider health, free quota, eval scores, hosts, and lessons">
      {(token, lock) => <OpsPage token={token} onUnauthorized={lock} />}
    </PageShell>
  );
}
