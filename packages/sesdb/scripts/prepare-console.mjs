import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const siteExport = resolve(packageRoot, "../../site/out");
const target = resolve(packageRoot, "console/site");
if (!existsSync(resolve(siteExport, "console.html"))) {
  console.error("Missing Site static export. Run `pnpm build` in site/ before packing SESDB.");
  process.exit(1);
}
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(siteExport, target, { recursive: true });
