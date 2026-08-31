import type { Metadata } from "next";
import { Archivo, Inter_Tight, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const display = Archivo({ subsets: ["latin"], variable: "--font-display-loaded", weight: ["600", "700"] });
const body = Inter_Tight({ subsets: ["latin"], variable: "--font-body-loaded" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-data-loaded", weight: ["400", "500"] });

export const metadata: Metadata = {
  title: "TITAN-Runner",
  description: "Live pulse status, task queue, and run history for TITAN-Runner.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${display.variable} ${body.variable} ${mono.variable}`}>{children}</body>
    </html>
  );
}
