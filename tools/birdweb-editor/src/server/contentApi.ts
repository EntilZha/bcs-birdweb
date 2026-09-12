import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Plugin, ViteDevServer } from "vite";
import yaml from "js-yaml";
import sharp from "sharp";
import {
  ecoregionSchema,
  siteSchema,
  speciesSchema,
} from "../../../../src/content.schemas";

const exec = promisify(execFile);

/**
 * The editor's backend: Vite dev-server middleware that reads and writes the YAML in
 * src/content/ directly.
 *
 * No separate API process, no database. The files in git are the content, so the editor's
 * whole job is to be a good citizen of a version-controlled working tree: stable key
 * order, deterministic formatting, and a change that touches only the lines a person
 * actually edited. Anything else makes review impossible and makes the tool untrustworthy.
 */

interface Options {
  repoRoot: string;
}

// Written in this order, always. A file whose keys reshuffle on every save produces a diff
// nobody can review, which is the fastest way to make people stop using the editor.
const SPECIES_KEY_ORDER = [
  "slug", "common_name", "scientific_name", "order", "family", "status",
  "species_of_concern", "sections", "photos", "audio", "maps", "abundance",
  "taxonomy", "source",
];
const SITE_KEY_ORDER = [
  "slug", "name", "number", "ecoregions", "sections", "photos",
  "lat", "lon", "county", "geocode_source", "source",
];
const PHOTO_KEY_ORDER = ["file", "caption", "credit", "hero"];
const SECTION_ORDER = [
  "general_description", "habitat", "behavior", "diet", "nesting",
  "migration_status", "conservation_status", "when_where_wa",
];

const COLLECTIONS = {
  species: { schema: speciesSchema, keyOrder: SPECIES_KEY_ORDER },
  sites: { schema: siteSchema, keyOrder: SITE_KEY_ORDER },
  ecoregions: { schema: ecoregionSchema, keyOrder: ["slug", "name", "sections", "map", "source"] },
} as const;

type CollectionName = keyof typeof COLLECTIONS;

export function contentApi({ repoRoot }: Options): Plugin {
  const contentRoot = path.join(repoRoot, "src", "content");
  const assetsRoot = path.join(repoRoot, "src", "assets");
  const backedUp = new Set<string>();

  const collectionDir = (name: CollectionName) => path.join(contentRoot, name);

  function recordPath(collection: CollectionName, slug: string): string {
    // Slug comes from the client, so it must never be able to escape the collection dir.
    const safe = path.basename(slug);
    const target = path.join(collectionDir(collection), `${safe}.yaml`);
    if (!target.startsWith(collectionDir(collection))) {
      throw new Error("path traversal");
    }
    return target;
  }

  function listRecords(collection: CollectionName) {
    const dir = collectionDir(collection);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".yaml"))
      .map((f) => {
        const data = yaml.load(fs.readFileSync(path.join(dir, f), "utf8")) as Record<
          string,
          unknown
        >;
        return { slug: path.basename(f, ".yaml"), data };
      });
  }

  /** Known keys first in a fixed order, then any extras -- unknown keys are preserved. */
  function ordered<T extends Record<string, unknown>>(record: T, keyOrder: readonly string[]): T {
    const out: Record<string, unknown> = {};
    for (const key of keyOrder) if (key in record) out[key] = record[key];
    for (const [key, value] of Object.entries(record)) if (!(key in out)) out[key] = value;
    return out as T;
  }

  function canonicalize(collection: CollectionName, record: Record<string, unknown>) {
    const out = ordered(record, COLLECTIONS[collection].keyOrder);
    if (Array.isArray(out.photos)) {
      out.photos = (out.photos as Record<string, unknown>[]).map((p) =>
        ordered(p, PHOTO_KEY_ORDER),
      );
    }
    if (collection === "species" && out.sections && typeof out.sections === "object") {
      out.sections = ordered(out.sections as Record<string, unknown>, SECTION_ORDER);
    }
    return out;
  }

  /**
   * Serialize a record byte-identically to what scripts/extract_birdweb.py writes.
   *
   * The two writers have to agree exactly, or the first time the editor touches a species
   * it reformats the whole file and buries the actual edit. The one place js-yaml and
   * PyYAML disagree is the abundance rows: PyYAML emits them in flow style
   * (`oceanic: ['', '', …]`), js-yaml has no per-key style control and would write 120
   * lines of block sequence. So abundance is lifted out, rendered by hand, and spliced
   * back at its placeholder.
   */
  function dump(record: Record<string, unknown>): string {
    const abundance = record.abundance as Record<string, string[]> | undefined;
    const placeholder = "__BIRDWEB_ABUNDANCE__";
    const text = yaml.dump(abundance ? { ...record, abundance: placeholder } : record, {
      sortKeys: false,
      // No wrapping: a reflowed paragraph turns a one-word edit into a whole-block diff.
      lineWidth: -1,
      noRefs: true,
      noArrayIndent: true,
    });
    if (!abundance) return text;

    const rows = Object.entries(abundance)
      .map(([slug, months]) => {
        const cells = months.map((code) => (code === "" ? "''" : code)).join(", ");
        return `  ${slug}: [${cells}]`;
      })
      .join("\n");
    return text.replace(`abundance: ${placeholder}`, `abundance:\n${rows}`);
  }

  function save(collection: CollectionName, slug: string, record: Record<string, unknown>) {
    const target = recordPath(collection, slug);

    // One backup per file per dev-server session: cheap undo insurance for a tool that
    // writes as you type. Gitignored, and sweepable from /api/backups.
    if (!backedUp.has(target) && fs.existsSync(target)) {
      const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
      fs.copyFileSync(target, `${target}.backup.${stamp}`);
      backedUp.add(target);
    }

    fs.writeFileSync(target, dump(canonicalize(collection, record)), "utf8");
  }

  async function serveThumb(
    res: import("node:http").ServerResponse,
    file: string,
    width: number,
  ) {
    const resolved = path.resolve(assetsRoot, file);
    if (!resolved.startsWith(assetsRoot) || !fs.existsSync(resolved)) {
      res.statusCode = 404;
      return res.end("not found");
    }
    const buffer = await sharp(resolved)
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
    res.setHeader("Content-Type", "image/webp");
    res.setHeader("Cache-Control", "no-cache");
    res.end(buffer);
  }

  return {
    name: "birdweb-editor-api",
    configureServer(server: ViteDevServer) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url || "/", "http://localhost");
        const { pathname } = url;

        if (pathname.startsWith("/assets/")) {
          const width = Number(url.searchParams.get("w") || 400);
          try {
            return await serveThumb(res, decodeURIComponent(pathname.slice(8)), width);
          } catch {
            res.statusCode = 500;
            return res.end("image error");
          }
        }

        if (!pathname.startsWith("/api/")) return next();

        const json = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(body));
        };

        const readBody = async (): Promise<any> => {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        };

        try {
          // GET /api/<collection> — index, trimmed to what the list view needs.
          const indexMatch = pathname.match(/^\/api\/(species|sites|ecoregions)$/);
          if (indexMatch && req.method === "GET") {
            const collection = indexMatch[1] as CollectionName;
            const records = listRecords(collection).map(({ slug, data }) => ({
              slug,
              name: (data.common_name as string) || (data.name as string) || slug,
              scientific: (data.scientific_name as string) ?? null,
              family: (data.family as { name?: string })?.name ?? null,
              photoCount: Array.isArray(data.photos) ? data.photos.length : 0,
              hasAbundance:
                collection === "species" &&
                Object.values((data.abundance as Record<string, string[]>) || {}).some((row) =>
                  row.some((code) => code !== ""),
                ),
              needsGeocode: collection === "sites" && data.lat == null,
            }));
            return json(200, { records });
          }

          // GET/POST /api/<collection>/<slug>
          const recordMatch = pathname.match(/^\/api\/(species|sites|ecoregions)\/(.+)$/);
          if (recordMatch) {
            const collection = recordMatch[1] as CollectionName;
            const slug = decodeURIComponent(recordMatch[2]);
            const file = recordPath(collection, slug);

            if (req.method === "GET") {
              if (!fs.existsSync(file)) return json(404, { error: "not found" });
              return json(200, { data: yaml.load(fs.readFileSync(file, "utf8")) });
            }

            if (req.method === "POST") {
              const body = await readBody();
              // Validate against the same schema Astro builds with, so the editor cannot
              // write a file that breaks the site. Errors come back per-field.
              const parsed = COLLECTIONS[collection].schema.safeParse(body.data);
              if (!parsed.success) {
                return json(422, {
                  error: "validation failed",
                  issues: parsed.error.issues.map((i) => ({
                    path: i.path.join("."),
                    message: i.message,
                  })),
                });
              }
              save(collection, slug, body.data);
              return json(200, { ok: true, saved: new Date().toISOString() });
            }
          }

          /**
           * GET/POST /api/taxonomy-overrides — the twenty species where a post-2005 split
           * or lump needed a human decision about which daughter species occurs in
           * Washington. Edited here rather than in a text editor because the reasoning
           * fields matter and are easy to clobber.
           */
          if (pathname === "/api/taxonomy-overrides") {
            const file = path.join(repoRoot, "src", "config", "taxonomy-overrides.yaml");
            if (req.method === "GET") {
              if (!fs.existsSync(file)) return json(200, { species: {} });
              const text = fs.readFileSync(file, "utf8");
              const parsed = (yaml.load(text) || {}) as { species?: Record<string, unknown> };
              // The file's header comments explain why each entry exists; hand them back so
              // a save can put them right back rather than silently dropping them.
              const header = text.slice(0, text.indexOf("species:"));
              return json(200, { species: parsed.species || {}, header });
            }
            if (req.method === "POST") {
              const body = await readBody();
              const header = typeof body.header === "string" ? body.header : "";
              const text =
                header +
                yaml.dump({ species: body.species || {} }, {
                  sortKeys: true,
                  lineWidth: 100,
                  noRefs: true,
                });
              fs.writeFileSync(file, text, "utf8");
              return json(200, { ok: true });
            }
          }

          /**
           * GET /api/credits — every photographer across species and sites, with how many
           * images each contributed. Aggregated here because the credit lives per-photo in
           * the source data and nowhere else, so a misspelled name is otherwise invisible
           * and unfixable in bulk.
           */
          if (pathname === "/api/credits" && req.method === "GET") {
            const tally = new Map<string, { count: number; urls: Set<string>; where: string[] }>();
            for (const collection of ["species", "sites"] as CollectionName[]) {
              for (const { slug, data } of listRecords(collection)) {
                for (const photo of (data.photos as Array<Record<string, any>>) || []) {
                  const name = (photo?.credit?.name || "").trim();
                  if (!name) continue;
                  const entry =
                    tally.get(name) || { count: 0, urls: new Set<string>(), where: [] };
                  entry.count += 1;
                  if (photo.credit.url) entry.urls.add(photo.credit.url);
                  if (entry.where.length < 40) entry.where.push(`${collection}/${slug}`);
                  tally.set(name, entry);
                }
              }
            }
            const credits = [...tally.entries()]
              .map(([name, v]) => ({
                name,
                count: v.count,
                urls: [...v.urls],
                where: v.where,
              }))
              .sort((a, b) => a.name.localeCompare(b.name));
            return json(200, { credits });
          }

          /**
           * POST /api/credits/rename — change a photographer's name everywhere at once.
           *
           * These names were typed per-photo over twenty years, so the same person appears
           * with variant spellings. Fixing that one record at a time across 2,200 photos is
           * not work anyone will do, and getting a contributor's name right is the least
           * this rebuild owes them.
           */
          if (pathname === "/api/credits/rename" && req.method === "POST") {
            const body = await readBody();
            const from = String(body.from || "").trim();
            const to = String(body.to || "").trim();
            const url = body.url === undefined ? undefined : String(body.url || "").trim();
            if (!from || !to) return json(400, { error: "both names are required" });

            let photos = 0;
            const touched: string[] = [];
            for (const collection of ["species", "sites"] as CollectionName[]) {
              for (const { slug, data } of listRecords(collection)) {
                let changed = false;
                for (const photo of (data.photos as Array<Record<string, any>>) || []) {
                  if ((photo?.credit?.name || "").trim() !== from) continue;
                  photo.credit.name = to;
                  if (url !== undefined) photo.credit.url = url || null;
                  changed = true;
                  photos += 1;
                }
                if (changed) {
                  save(collection, slug, data);
                  touched.push(`${collection}/${slug}`);
                }
              }
            }
            return json(200, { ok: true, photos, records: touched.length });
          }

          // GET /api/backups — what this session has written, and how to clean up.
          if (pathname === "/api/backups" && req.method === "GET") {
            const found: string[] = [];
            for (const collection of Object.keys(COLLECTIONS) as CollectionName[]) {
              const dir = collectionDir(collection);
              if (!fs.existsSync(dir)) continue;
              for (const file of fs.readdirSync(dir)) {
                if (file.includes(".yaml.backup.")) found.push(`${collection}/${file}`);
              }
            }
            return json(200, { backups: found });
          }

          if (pathname === "/api/backups" && req.method === "DELETE") {
            let removed = 0;
            for (const collection of Object.keys(COLLECTIONS) as CollectionName[]) {
              const dir = collectionDir(collection);
              if (!fs.existsSync(dir)) continue;
              for (const file of fs.readdirSync(dir)) {
                if (file.includes(".yaml.backup.")) {
                  fs.unlinkSync(path.join(dir, file));
                  removed++;
                }
              }
            }
            return json(200, { removed });
          }

          // GET /api/status — uncommitted changes, so an editor can see their own work.
          if (pathname === "/api/status" && req.method === "GET") {
            try {
              const { stdout } = await exec("sl", ["status", "src/content"], {
                cwd: repoRoot,
              });
              const changed = stdout
                .split("\n")
                .filter((line) => line.trim() && !line.includes(".backup."))
                .map((line) => line.trim());
              let remote: string | null = null;
              try {
                const paths = await exec("sl", ["paths"], { cwd: repoRoot });
                remote = paths.stdout.trim() || null;
              } catch {
                remote = null;
              }
              return json(200, { vcs: "sapling", changed, remote });
            } catch {
              return json(200, { vcs: null, changed: [], remote: null });
            }
          }

          /**
           * POST /api/publish — commit the content changes, and optionally push.
           *
           * The point of the editor is that nobody at BCS should need a terminal to fix a
           * typo in a species account. Committing and pushing are kept as two separate,
           * explicitly-chosen steps rather than one "Publish" that does both: a commit is
           * local and reversible, a push is visible to the world and triggers a deploy,
           * and those deserve different amounts of thought.
           *
           * Only fixed sl subcommands are ever run, and the message travels as an argv
           * element rather than through a shell, so nothing typed into the box can become
           * a command.
           */
          if (pathname === "/api/publish" && req.method === "POST") {
            const body = await readBody();
            const message = String(body.message || "").trim();
            const push = Boolean(body.push);
            if (!message) return json(400, { error: "a commit message is required" });
            if (message.length > 500) return json(400, { error: "message too long" });

            const steps: Array<{ step: string; output: string }> = [];
            try {
              const add = await exec("sl", ["add", "src/content"], { cwd: repoRoot });
              steps.push({ step: "sl add src/content", output: add.stdout.trim() });

              const commit = await exec("sl", ["commit", "-m", message], { cwd: repoRoot });
              steps.push({ step: "sl commit", output: commit.stdout.trim() || "committed" });

              if (push) {
                const pushed = await exec("sl", ["push"], { cwd: repoRoot });
                steps.push({ step: "sl push", output: pushed.stdout.trim() || "pushed" });
              }
              return json(200, { ok: true, pushed: push, steps });
            } catch (error) {
              const err = error as { stdout?: string; stderr?: string; message?: string };
              return json(500, {
                error: (err.stderr || err.stdout || err.message || String(error)).trim(),
                steps,
              });
            }
          }

          return json(404, { error: "unknown endpoint" });
        } catch (error) {
          return json(500, { error: String(error) });
        }
      });
    },
  };
}
