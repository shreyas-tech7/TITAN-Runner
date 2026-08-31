import type { NextConfig } from "next";

// GitHub Pages serves a project site (not a user/org site) at
// https://<owner>.github.io/<repo>/ — every asset path needs that prefix, or
// every request 404s one level too shallow. The deploy workflow sets
// GITHUB_PAGES_BASE_PATH to "/<repo>"; a local `next dev`/`next build` run
// leaves it unset and serves from "/", which is what you want for
// `npm run dev`.
const basePath = process.env.GITHUB_PAGES_BASE_PATH || "";

const nextConfig: NextConfig = {
  output: "export",
  basePath,
  assetPrefix: basePath || undefined,
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
    // Which repo to poll raw.githubusercontent.com against at runtime — set
    // by the deploy workflow from GITHUB_REPOSITORY_OWNER/GITHUB_REPOSITORY;
    // a local dev build falls back to this repo's own name.
    NEXT_PUBLIC_GITHUB_OWNER: process.env.NEXT_PUBLIC_GITHUB_OWNER || "shreyas-tech7",
    NEXT_PUBLIC_GITHUB_REPO: process.env.NEXT_PUBLIC_GITHUB_REPO || "TITAN-Runner",
  },
};

export default nextConfig;
