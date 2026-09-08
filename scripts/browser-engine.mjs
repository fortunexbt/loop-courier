import { chromium, webkit } from "playwright";

export function launchBrowser() {
  const name = process.env.LOOP_COURIER_BROWSER || "chromium";
  const engines = { chromium, webkit };
  if (!Object.hasOwn(engines, name)) throw new Error(`Unsupported browser engine: ${name}`);
  return engines[name].launch({ headless: true });
}
