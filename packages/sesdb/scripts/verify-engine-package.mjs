import { accessSync, constants } from "node:fs";
import { join } from "node:path";

const required = ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"];
const missing = [];
for (const platform of required) {
  for (const name of ["sesdb-engine", "sesdbd"]) {
    const binary = join("bin", platform, platform.startsWith("win32-") ? `${name}.exe` : name);
    try {
      accessSync(binary, platform.startsWith("win32-") ? constants.F_OK : constants.X_OK);
    } catch {
      missing.push(binary);
    }
  }
}
try { accessSync(join("console", "index.html"), constants.F_OK); } catch { missing.push("console/index.html"); }
try { accessSync(join("console", "site", "console.html"), constants.F_OK); } catch { missing.push("console/site/console.html"); }

if (missing.length) {
  console.error("Refusing to publish an unusable SESDB package. Missing engine/daemon/Console artifacts:");
  for (const binary of missing) console.error(`  - ${binary}`);
  console.error("Populate all release artifacts in CI before npm pack/publish.");
  process.exit(1);
}
