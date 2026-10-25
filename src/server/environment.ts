import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

/** Load only the launch directory's .env; exported variables always take precedence. */
export function loadEnvironmentFile(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): void {
  let source: string;
  try {
    source = fs.readFileSync(path.join(cwd, ".env"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const [key, value] of Object.entries(parseEnv(source))) {
    if (env[key] === undefined) env[key] = value;
  }
}

export function parseAllowedHosts(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(/[,;\s]+/u).map((host) => host.trim()).filter(Boolean))];
}
