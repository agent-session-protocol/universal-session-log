import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const repositorySkill = resolve(packageRoot, "../../skills/sesdb");
for (const path of ["SKILL.md", "agents/openai.yaml"]) {
  const packaged = readFileSync(resolve(packageRoot, "skill", path));
  const repository = readFileSync(resolve(repositorySkill, path));
  if (!packaged.equals(repository)) throw new Error(`packaged SESDB skill drifted: ${path}`);
}
console.log("Packaged SESDB skill matches the repository skill.");
