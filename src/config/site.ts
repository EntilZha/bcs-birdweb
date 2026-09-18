/**
 * Whether search engines may index this site.
 *
 * Off for now, deliberately and temporarily. The repository is public — which is the right
 * call for a project that exists *because* one unmaintained server held the only copy — but
 * the content has not been through BCS review yet: `src/config/taxonomy-overrides.yaml`
 * carries 20 hand-resolved decisions awaiting the Science Committee, and the accounts
 * themselves are ~20 years old in places. Until that review lands, this site presents an
 * organization's material under a personal account, and it should not be something a
 * visitor finds by searching for a species.
 *
 * This is not a security control. Anyone with the URL can read the site, and the repository
 * is public; it only keeps the site out of search results.
 *
 * To publish for real: flip this to `true`, rebuild, and let the sitemap do its job. That
 * is the whole change — it drives the robots meta tag on both layouts and /robots.txt.
 */
export const INDEXABLE = false;
