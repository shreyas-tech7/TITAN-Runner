import type { Metadata, Viewport } from "next";
import { Inter_Tight, JetBrains_Mono } from "next/font/google";
import "./tokens.css";
import "./globals.css";
import ServiceWorkerRegistration from "@/components/ServiceWorkerRegistration";
import { buildRunnerCsp } from "@/lib/csp";
import { parseGevUrl } from "@/lib/gev";

// Two type roles only, per the redesign brief: JetBrains Mono for every
// number/id/timing, Inter Tight for prose and labels. The previous third
// face (Archivo, an uppercase display face) is gone — real hierarchy here
// comes from size/weight contrast within these two, not a third family.
const body = Inter_Tight({ subsets: ["latin"], variable: "--font-body-loaded", weight: ["400", "500", "600", "700"] });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-data-loaded", weight: ["400", "500", "600"] });

// GitHub Pages serves this site under /<repo>/, so every link that points at a file in public/ needs that
// prefix. Without it the manifest and the icons pointed at the site root, where they do not exist, and the
// browser never found a manifest, so the page was not installable.
const BASE = process.env.NEXT_PUBLIC_BASE_PATH || "";

export const metadata: Metadata = {
  title: "TITAN-Runner",
  description: "Live pulse status, task queue, and run history for TITAN-Runner.",
  manifest: `${BASE}/manifest.webmanifest`,
  icons: {
    icon: [
      { url: `${BASE}/icons/icon-192.png`, sizes: "192x192", type: "image/png" },
      { url: `${BASE}/icons/icon-512.png`, sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: `${BASE}/icons/icon-192.png`, sizes: "192x192", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "TITAN-Runner",
  },
  referrer: "no-referrer",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0a0e15",
};

// GitHub Pages cannot send response headers, so the policy is a meta tag. See lib/csp.ts for what it
// covers. The only frame the page ever embeds is the God's Eye View host, when one is set.
const csp = buildRunnerCsp({ worker: process.env.NEXT_PUBLIC_TITAN_WORKER_URL || "", gevOrigin: (() => {
  const t = parseGevUrl(process.env.NEXT_PUBLIC_GEV_URL);
  return t.ok ? t.origin : null;
})() });

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="eclipse">
      <head>
        <meta httpEquiv="Content-Security-Policy" content={csp} />
        <script src={`${BASE}/theme-boot.js`} />
      </head>
      <body className={`${body.variable} ${mono.variable}`}>
        {children}
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
