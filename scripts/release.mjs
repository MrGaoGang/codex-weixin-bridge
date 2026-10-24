import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

function stableParts(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`Expected a stable version: ${version}`);
  }
  return version.split(".").map(BigInt);
}

export function nextVersion(local, published) {
  let parts = stableParts(local);
  if (published) {
    const remote = stableParts(published);
    for (let i = 0; i < 3; i++) {
      if (remote[i] > parts[i]) { parts = remote; break; }
      if (remote[i] < parts[i]) break;
    }
  }
  parts[2] += 1n;
  return parts.join(".");
}

export function updateReadme(text, name, version) {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const pattern = /<!-- release:start -->[\s\S]*?<!-- release:end -->/;
  if (!pattern.test(text)) throw new Error("README release markers are missing");
  const block = [
    "<!-- release:start -->",
    `[![npm version](https://img.shields.io/npm/v/${encodeURIComponent(name)})](https://www.npmjs.com/package/${name})`,
    "",
    `**npm: ${name}@${version}**`,
    "",
    "```bash",
    `npm install -g ${name}@${version}`,
    "codex-weixin",
    "```",
    "<!-- release:end -->"
  ].join(newline);
  return text.replace(pattern, () => block);
}

async function main() {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  let version;
  if (process.argv[2] === "--set") {
    version = process.argv[3];
    stableParts(version);
  } else {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/latest`, {
      signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`npm version lookup failed: HTTP ${response.status}`);
    }
    const published = response.status === 404 ? undefined : (await response.json()).version;
    version = nextVersion(pkg.version, published);
  }
  const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
  // Validate and prepare every document before writing any files.
  const readmes = ["README.md", "README.en.md"].map((file) => [file,
    updateReadme(fs.readFileSync(file, "utf8"), pkg.name, version)]);
  pkg.version = version;
  lock.name = lock.packages[""].name = pkg.name;
  lock.version = lock.packages[""].version = version;
  fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
  fs.writeFileSync("package-lock.json", JSON.stringify(lock, null, 2) + "\n");
  for (const [file, text] of readmes) fs.writeFileSync(file, text);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
  console.log(`Prepared ${pkg.name}@${version}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
