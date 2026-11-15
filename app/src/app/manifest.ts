import type { MetadataRoute } from "next";
import { site } from "@/content/site";

/**
 * Web app manifest: the installable PWA, and the base of the Solana dApp Store app (a Trusted Web Activity wraps it).
 * Colours are the design tokens' page background (site.themeLight = --bg in light mode; the dark one is set per
 * colour scheme by the theme-color meta in layout.tsx). Maskable icons: scripts/pwa-icons.mjs. Screenshots: the demo
 * at 412 px (phone) and 1280 px (wide), shown by Android's richer install sheet and reused for the store listing.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: `${site.name}: ${site.tagline}`,
    short_name: site.shortName,
    description: site.description,
    lang: "en-ZA",
    start_url: "/chat",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: site.themeLight,
    theme_color: site.themeLight,
    categories: ["finance", "lifestyle"],
    icons: [
      { src: "/icons/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    screenshots: site.screenshots.map((sc) => ({ src: sc.src, sizes: sc.sizes, type: "image/webp", form_factor: sc.formFactor, label: sc.label })),
    shortcuts: [
      { name: "Ask Heirloom", url: "/chat" },
      { name: "Estate", url: "/estate" },
      { name: "Claims", url: "/claims" },
      { name: "Inbox", url: "/inbox" },
    ],
  };
}
