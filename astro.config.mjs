// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

// GitHub Pages project-site config: the site is served from
// https://<owner>.github.io/<repo>/, so `base` must be the repo name. Every internal
// link and public asset therefore has to go through import.meta.env.BASE_URL —
// forgetting it is the single most common way to ship a page of 404s here.
//
// If birdweb.org DNS is ever recovered, `base` drops to '/' and `site` changes; nothing
// else should need to move, which is why nothing hardcodes the prefix.
export default defineConfig({
  site: 'https://entilzha.github.io',
  base: '/bcs-birdweb/',
  integrations: [react(), sitemap()],
  vite: { plugins: [tailwindcss()] },
});
