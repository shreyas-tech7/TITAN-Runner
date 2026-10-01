import type { Metadata, Viewport } from "next";
import { Inter_Tight, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import ServiceWorkerRegistration from "@/components/ServiceWorkerRegistration";
import { gevFrameSrcPolicy, parseGevUrl } from "@/lib/gev";

// Two type roles only, per the redesign brief: JetBrains Mono for every
// number/id/timing, Inter Tight for prose and labels. The previous third
// face (Archivo, an uppercase display face) is gone — real hierarchy here
// comes from size/weight contrast within these two, not a third family.
const body = Inter_Tight({ subsets: ["latin"], variable: "--font-body-loaded", weight: ["400", "500", "600", "700"] });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-data-loaded", weight: ["400", "500", "600"] });

export const metadata: Metadata = {
  title: "TITAN-Runner",
  description: "Live pulse status, task queue, and run history for TITAN-Runner.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "TITAN-Runner",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#16181c",
};

// GitHub Pages cannot send response headers, so this dashboard has no CSP of its
// own. The only frame it ever embeds is the God's Eye View Space. When that URL
// is set, a meta CSP allows framing that one origin and nothing else. It sets no
// other directive, so it changes nothing else about the page.
const gevFramePolicy = gevFrameSrcPolicy(parseGevUrl(process.env.NEXT_PUBLIC_GEV_URL));

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      {gevFramePolicy && (
        <head>
          <meta httpEquiv="Content-Security-Policy" content={gevFramePolicy} />
        </head>
      )}
      <body className={`${body.variable} ${mono.variable}`}>
        {children}
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
