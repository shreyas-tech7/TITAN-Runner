"use client";

import PageShell from "@/components/PageShell";
import HowItWorksView from "@/components/HowItWorksView";

export default function HowItWorksRoute() {
  return (
    <PageShell
      active="how-it-works"
      title="How TITAN-Runner Works"
      subtitle="Zero-server, $0/month personal AI runtime built on GitHub Pages, Cloudflare Workers, D1, and GitHub Actions"
    >
      {() => <HowItWorksView />}
    </PageShell>
  );
}
