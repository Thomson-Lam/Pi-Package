import { createJiti } from "../../../node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url, { interopDefault: true });

export function load(path) {
  return jiti.import(new URL(path, import.meta.url).pathname);
}
