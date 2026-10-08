import Link from "next/link";

/**
 * The dashboard's top level tabs. Each tab is its own route (the dashboard is a static export, so a route per tab keeps
 * every view deep-linkable) and the current one carries `aria-current="page"`. The order is fixed by the Wave 12 brief:
 * Dashboard, Chat, Connectors, Keys, Health, God's Eye View. A tab appears when its page ships.
 */
export type TopTab = "dashboard" | "keys" | "gods-eye";

const TABS: { id: TopTab; label: string; href: string }[] = [
  { id: "dashboard", label: "Dashboard", href: "/" },
  { id: "keys", label: "Keys", href: "/keys" },
  { id: "gods-eye", label: "God's Eye View", href: "/ops/gods-eye" },
];

export default function TopTabs({ active }: { active: TopTab }) {
  return (
    <nav className="top-tabs" aria-label="Sections">
      {TABS.map((tab) => (
        <Link key={tab.id} className="top-tab" href={tab.href} aria-current={tab.id === active ? "page" : undefined}>
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
