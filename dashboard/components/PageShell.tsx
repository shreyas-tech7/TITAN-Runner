"use client";

/**
 * The frame of every page after the home page: the admin gate, the title bar, the top tabs, and the main area.
 * The render prop gets the admin token and a function that locks the dashboard again.
 */
import type { ReactNode } from "react";
import AdminGate from "@/components/AdminGate";
import ThemeSwitch from "@/components/ThemeSwitch";
import TopTabs, { type TopTab } from "@/components/TopTabs";
import OfflineNotice from "@/components/OfflineNotice";

export default function PageShell({
  active,
  title,
  subtitle,
  children,
}: {
  active: TopTab;
  title: string;
  subtitle: string;
  children: (token: string, lock: () => void) => ReactNode;
}) {
  return (
    <AdminGate>
      {(token, lock) => (
        <div className="shell">
          <header className="topbar">
            <div>
              <h1 className="brand">{title}</h1>
              <div className="brand-sub">{subtitle}</div>
            </div>
            <div className="topbar-actions">
              <ThemeSwitch />
            </div>
          </header>
          <TopTabs active={active} />
          <main id="main">
            <OfflineNotice />
            {children(token, lock)}
          </main>
        </div>
      )}
    </AdminGate>
  );
}
