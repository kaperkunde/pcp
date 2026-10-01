import type { MetadataRoute } from "next"

// Icons live in public/icons; assets/icon.png is the master they are cut from.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "PCP",
    short_name: "PCP",
    description:
      "A self-hosted gateway to your MCP servers, with the secrets they need kept encrypted.",
    start_url: "/",
    display: "standalone",
    background_color: "#131720",
    theme_color: "#131720",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/icons/icon-maskable-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  }
}
