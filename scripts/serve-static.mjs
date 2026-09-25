/**
 * serve-static.mjs — dependency-free static file server for the `out/` export.
 *
 * Usage:
 *   npm run preview:static          # serves out/ on http://localhost:4173
 *   PORT=8080 node scripts/serve-static.mjs
 *
 * Implements Cloudflare Pages-compatible resolution:
 *   /              -> /index.html
 *   /foo           -> /foo.html, then /foo/index.html
 *   /foo/          -> /foo/index.html
 *   missing        -> /404.html (with 404 status)
 */

import { createServer } from "node:http"
import { readFile, stat } from "node:fs/promises"
import { extname, join, normalize } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "out")
const PORT = Number(process.env.PORT) || 4173

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
}

async function tryFile(candidate) {
  try {
    const s = await stat(candidate)
    if (s.isFile()) return candidate
  } catch {
    /* ignore */
  }
  return null
}

async function resolvePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0])
  const safe = normalize(decoded).replace(/^(\.\.[/\\])+/, "")
  const rel = safe.replace(/^[/\\]+/, "")
  const base = join(ROOT, rel)

  if (rel === "" || rel.endsWith("/")) {
    return (await tryFile(join(base, "index.html"))) || (await tryFile(base + ".html"))
  }
  if (extname(rel) === "") {
    return (
      (await tryFile(base + ".html")) ||
      (await tryFile(join(base, "index.html"))) ||
      (await tryFile(base + "/index.html"))
    )
  }
  return await tryFile(base)
}

const server = createServer(async (req, res) => {
  const urlPath = req.url || "/"
  try {
    let file = await resolvePath(urlPath)
    let status = 200
    if (!file) {
      file = await tryFile(join(ROOT, "404.html"))
      status = file ? 404 : 200
    }
    if (!file) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
      res.end("404 Not Found")
      return
    }
    const type = MIME[extname(file).toLowerCase()] || "application/octet-stream"
    res.writeHead(status, {
      "Content-Type": type,
      "Cache-Control": status === 200 && extname(file) !== ".html" ? "public, max-age=31536000, immutable" : "no-cache",
    })
    res.end(await readFile(file))
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" })
    res.end("Internal Server Error")
    console.error(err)
  }
})

server.listen(PORT, () => {
  console.log(`Serving static export from ${ROOT}`)
  console.log(`  → http://localhost:${PORT}`)
})
