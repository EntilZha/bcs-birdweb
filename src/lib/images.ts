import type { ImageMetadata } from "astro";

/**
 * Resolve the asset references stored in src/content/ to real image modules.
 *
 * The YAML keeps each asset's *original* archive filename (`mall_fl_gl_l.jpg`) because
 * that is its provenance -- it is the name in archive/manifest.jsonl and on the legacy
 * server. scripts/build_images.py writes WebP derivatives under the same stem, and this
 * module bridges the two by stem. Keeping the indirection here is what lets `pixi run
 * extract` and `pixi run images` run in either order without one clobbering the other.
 *
 * Eager globs so Astro fingerprints and optimizes every image at build time.
 */

const birdImages = import.meta.glob<{ default: ImageMetadata }>(
  "../assets/birds/**/*.webp",
  { eager: true },
);
const siteImages = import.meta.glob<{ default: ImageMetadata }>(
  "../assets/sites/**/*.webp",
  { eager: true },
);
const mapImages = import.meta.glob<{ default: ImageMetadata }>("../assets/maps/*.webp", {
  eager: true,
});
const ecoregionImages = import.meta.glob<{ default: ImageMetadata }>(
  "../assets/ecoregions/*.webp",
  { eager: true },
);

/** `mall_fl_gl_l.jpg` -> `mall_fl_gl_l` */
function stem(file: string): string {
  return file.replace(/\.[^.]+$/, "");
}

function lookup(
  modules: Record<string, { default: ImageMetadata }>,
  path: string,
): ImageMetadata | null {
  return modules[path]?.default ?? null;
}

export function birdImage(speciesSlug: string, file: string | null | undefined) {
  if (!file) return null;
  return lookup(birdImages, `../assets/birds/${speciesSlug}/${stem(file)}.webp`);
}

export function siteImage(siteSlug: string, file: string | null | undefined) {
  if (!file) return null;
  return lookup(siteImages, `../assets/sites/${siteSlug}/${stem(file)}.webp`);
}

export function mapImage(file: string | null | undefined) {
  if (!file) return null;
  return lookup(mapImages, `../assets/maps/${stem(file)}.webp`);
}

export function ecoregionImage(file: string | null | undefined) {
  if (!file) return null;
  return lookup(ecoregionImages, `../assets/ecoregions/${stem(file)}.webp`);
}

/**
 * The image a species should lead with. Falls back to the first available photo when the
 * flagged hero has not been built yet, so a partial asset build still renders.
 */
export function heroImage<P extends { file: string; hero?: boolean }>(
  speciesSlug: string,
  photos: readonly P[],
): { image: ImageMetadata; photo: P } | null {
  const ordered = [...photos].sort((a, b) => Number(b.hero ?? false) - Number(a.hero ?? false));
  for (const photo of ordered) {
    const image = birdImage(speciesSlug, photo.file);
    if (image) return { image, photo };
  }
  return null;
}

/** True once any bird imagery has been built. Used to keep dev usable mid-pipeline. */
export const hasBirdImages = Object.keys(birdImages).length > 0;
