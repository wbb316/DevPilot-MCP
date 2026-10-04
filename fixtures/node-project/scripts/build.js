import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..");
const distDir = join(projectRoot, "dist");
const bundlePath = join(distDir, "bundle.txt");

await mkdir(distDir, { recursive: true });
await writeFile(bundlePath, "devpilot-fixture-node bundle\n", "utf8");
console.log("build ok");
