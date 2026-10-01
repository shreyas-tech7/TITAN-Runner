"use client";

/**
 * /ops/gods-eye is the God's Eye View tab. The real open source 3D globe
 * (live flights, military flights, earthquakes, satellites, street traffic,
 * CCTV) hosted by TITAN-GEV, in a full height iframe. The schematic provider
 * mesh globe on the main dashboard and the investigation log at
 * /ops/geospatial are separate views and keep working as before.
 */
import AdminGate from "@/components/AdminGate";
import GodsEyeTab from "@/components/GodsEyeTab";
import TopTabs from "@/components/TopTabs";

export default function GodsEyePage() {
  return (
    <AdminGate>
      {(token, lock) => (
        <div className="shell">
          <div className="topbar">
            <div>
              <h1 className="brand">God&apos;s Eye View</h1>
              <div className="brand-sub">The live 3D Earth, hosted through TITAN-GEV</div>
            </div>
          </div>
          <TopTabs active="gods-eye" />
          <GodsEyeTab token={token} onUnauthorized={lock} />
        </div>
      )}
    </AdminGate>
  );
}
