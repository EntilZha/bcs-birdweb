import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { contentApi } from "./src/server/contentApi";

const here = path.dirname(fileURLToPath(import.meta.url));
// tools/birdweb-editor -> repo root. The tool locates itself, so it can never be aimed at
// the wrong working tree and needs no arguments.
const repoRoot = path.resolve(here, "../..");

export default defineConfig({
  plugins: [react(), tailwindcss(), contentApi({ repoRoot })],
  // Binds loopback only: this process reads and writes files in the repo, so it must never
  // be reachable from the network.
  server: { host: "127.0.0.1", port: 5173 },
});
