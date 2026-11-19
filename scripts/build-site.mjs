import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { stripTestHooks } from "./strip-test-hooks.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const outputRoot = resolve(projectRoot, "site");

await rm(outputRoot, { recursive: true, force: true });
await mkdir(resolve(outputRoot, "assets", "fonts"), { recursive: true });

for (const file of ["index.html", "404.html", "style.css", "main.js", "game-core.js", "economy.js", "progression.js", "simulation-clock.js", "site.webmanifest"]) {
  await cp(resolve(projectRoot, file), resolve(outputRoot, file));
}

await writeFile(resolve(outputRoot, "main.js"), stripTestHooks(await readFile(resolve(projectRoot, "main.js"), "utf8")));

for (const file of ["favicon.svg", "apple-touch-icon.png", "og.png", "fonts/overpass-latin.woff2", "fonts/overpass-latin-italic.woff2", "fonts/OFL.txt"]) {
  await cp(resolve(projectRoot, "assets", file), resolve(outputRoot, "assets", file), { recursive: true });
}

console.log("Built dependency-free site artifact in site/");
