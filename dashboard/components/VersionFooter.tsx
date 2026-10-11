"use client";

/**
 * The footer line with the commit of the dashboard and the commit of the Worker (Wave 12, H4). A difference of two known
 * commits shows a small warning. It is normal for a short time after a deploy. If it stays, one deploy failed.
 * `GET /version` is public, so the call sends no token.
 */
import { useEffect, useState } from "react";
import { fetchWorkerVersion } from "@/lib/healthApi";
import { versionMismatch } from "@/lib/healthView";
import { workerUrl } from "@/lib/workerApi";

const DASHBOARD_COMMIT = process.env.NEXT_PUBLIC_COMMIT || "dev";

export default function VersionFooter() {
  const [worker, setWorker] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void fetchWorkerVersion(workerUrl()).then((v) => live && setWorker(v?.commit ?? null));
    return () => {
      live = false;
    };
  }, []);
  const short = (c: string | null | undefined) => (c && c !== "unknown" ? c.slice(0, 7) : c ?? "unknown");
  const mismatch = versionMismatch(DASHBOARD_COMMIT, worker);
  return (
    <p className="footer-note version-footer" aria-label="Versions">
      Dashboard <span className="e-num">{short(DASHBOARD_COMMIT)}</span>
      {workerUrl() ? (
        <>
          {" "}· Worker <span className="e-num">{worker === undefined ? "checking" : short(worker)}</span>
        </>
      ) : null}
      {mismatch ? <span className="text-warning"> · The two commits differ. A deploy may still run or may have failed. Check the Actions tab.</span> : null}
    </p>
  );
}
