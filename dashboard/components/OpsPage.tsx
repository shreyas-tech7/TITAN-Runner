"use client";

/**
 * The Ops page: the panels of the shared ops services (RO1 to RO5) and the lessons of the post-mortems (RO4). The
 * panels read the public mirrors in `state/ops/`, so they work when the Worker is down. The Security panel needs the
 * session and reads the Worker.
 */
import OpsHealthPanel from "@/components/OpsHealthPanel";
import OpsQuotaPanel from "@/components/OpsQuotaPanel";
import EvalScoresPanel from "@/components/EvalScoresPanel";
import HostStatusPanel from "@/components/HostStatusPanel";
import LessonsPanel from "@/components/LessonsPanel";
import SecurityPanel from "@/components/SecurityPanel";
import { parseLessons, type EvalMirror, type HealthMirror, type HostsMirror, type Lesson, type QuotaMirror } from "@/lib/opsView";
import { usePolledJson } from "@/lib/usePolledJson";

const POLL_MS = 60_000;

export default function OpsPage({ token, onUnauthorized }: { token: string; onUnauthorized: () => void }) {
  const health = usePolledJson<HealthMirror>("state/ops/health.json", POLL_MS);
  const quota = usePolledJson<QuotaMirror>("state/ops/quota.json", POLL_MS);
  const evalScores = usePolledJson<EvalMirror>("state/ops/eval.json", POLL_MS * 5);
  const hosts = usePolledJson<HostsMirror>("state/ops/hosts.json", POLL_MS);
  const lessons = usePolledJson<Lesson[]>("state/lessons.jsonl", POLL_MS * 5, parseLessons);

  return (
    <div className="ops-page">
      <div className="e-pair">
        <OpsHealthPanel health={health} />
        <OpsQuotaPanel quota={quota} />
      </div>
      <div className="e-pair">
        <HostStatusPanel hosts={hosts} />
        <EvalScoresPanel evalScores={evalScores} />
      </div>
      <LessonsPanel lessons={lessons} />
      <SecurityPanel token={token} onUnauthorized={onUnauthorized} />
    </div>
  );
}
