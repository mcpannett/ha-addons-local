// Test-only loader: let source files' "./x.js" imports resolve to "./x.ts" (as tsc/tsx do).
import { register } from "node:module";
register("data:text/javascript," + encodeURIComponent(`
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
export async function resolve(specifier, context, next) {
  if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {
    const ts = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
    if (existsSync(fileURLToPath(ts))) return next(ts.href, context);
  }
  return next(specifier, context);
}`));
