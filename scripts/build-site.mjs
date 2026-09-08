import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const outputRoot = resolve(projectRoot, "site");

await rm(outputRoot, { recursive: true, force: true });
await mkdir(resolve(outputRoot, "assets"), { recursive: true });

for (const file of ["index.html", "style.css", "main.js", "game-core.js", "progression.js", "simulation-clock.js", "site.webmanifest"]) {
  await cp(resolve(projectRoot, file), resolve(outputRoot, file));
}

for (const file of ["favicon.svg", "loop-courier-showcase.png"]) {
  await cp(resolve(projectRoot, "assets", file), resolve(outputRoot, "assets", file));
}

console.log("Built dependency-free site artifact in site/");
