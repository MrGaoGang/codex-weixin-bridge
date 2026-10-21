import { fileURLToPath } from "node:url";
import path from "node:path";

export async function waitForPublication(name, version, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const attempts = options.attempts ?? 30;
  const delayMs = options.delayMs ?? 10_000;
  let detail = "metadata not found";
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`, {
        headers: { "Cache-Control": "no-cache" }, signal: AbortSignal.timeout(15_000)
      });
      if (response.ok) {
        const pkg = await response.json();
        if (pkg.name === name && pkg.version === version && !pkg.stub && pkg.dist?.tarball) {
          const tarball = new URL(pkg.dist.tarball);
          if (tarball.origin !== "https://registry.npmjs.org") throw new Error("Unexpected tarball registry");
          const download = await fetchImpl(tarball.href, { method: "HEAD", signal: AbortSignal.timeout(15_000) });
          if (download.ok) return;
          detail = `tarball HTTP ${download.status}`;
        } else {
          detail = "placeholder or incomplete metadata";
        }
      } else {
        detail = `metadata HTTP ${response.status}`;
      }
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
    }
    if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`${name}@${version} is not publicly available: ${detail}. npm may still be processing it; check npm before publishing another version.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [name, version] = process.argv.slice(2);
  if (!name || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error("Usage: node scripts/verify-publication.mjs <name> <stable-version>");
  await waitForPublication(name, version);
  console.log(`Verified public metadata and tarball for ${name}@${version}`);
}
