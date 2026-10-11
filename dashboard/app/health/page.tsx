"use client";

/** /health is the Health Center. See components/HealthPage.tsx. */
import HealthPage from "@/components/HealthPage";
import PageShell from "@/components/PageShell";

export default function Page() {
  return (
    <PageShell active="health" title="Health" subtitle="What works, what does not, and how to fix it">
      {(token, lock) => <HealthPage token={token} onUnauthorized={lock} />}
    </PageShell>
  );
}
