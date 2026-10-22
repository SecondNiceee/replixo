import type { MetadataRoute } from "next"
import { SITE_URL } from "@/lib/seo"

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/api/",
          "/design-preview",
          "/logos",
          "/room/",
          "/profile",
          "/chat",
          "/notes/",
          "/sign-in",
          "/sign-up",
          "/forgot-password",
          "/reset-password",
          "/download/",
          "/examples",
          "/*?auth=",
          "/*?landing=",
        ],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  }
}
