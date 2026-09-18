import type { APIRoute } from "astro";
import { INDEXABLE } from "../config/site";

// Generated rather than a static public/robots.txt, so it cannot drift from the meta tag
// on the layouts. Both read src/config/site.ts.
export const GET: APIRoute = ({ site }) => {
  const sitemap = site ? `Sitemap: ${new URL("sitemap-index.xml", site).href}\n` : "";
  const body = INDEXABLE
    ? `User-agent: *\nAllow: /\n${sitemap}`
    : "User-agent: *\nDisallow: /\n";
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
