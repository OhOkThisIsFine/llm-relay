/**
 * Dashboard-only scan boundary; no server source is processed as UI content.
 *
 * ⚠ The globs are anchored to THIS directory, not left relative: Tailwind v3 resolves relative
 * content globs against the process CWD, and the build runs from the repo root
 * (`vite build --config dashboard/vite.config.ts`) — so `./src/**` silently scanned the SERVER
 * source, and any word there that names a utility became shipped CSS. The size ratchet caught it
 * on 2026-08-29: a source comment containing one such word grew the bundle by one utility rule.
 * Forward slashes, because the glob matcher does not treat backslashes as separators on Windows.
 */
const { join } = require("node:path");
const here = (p) => join(__dirname, p).replaceAll("\\", "/");
module.exports = { content: [here("index.html"), here("src/**/*.{ts,tsx}")], theme: { extend: {} }, plugins: [] };
