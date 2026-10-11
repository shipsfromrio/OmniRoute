// Resolution hook to import the OmniRoute catalog straight from source
// (Node type stripping), without node_modules or tsx: maps the `@/` alias to
// `<root>/src/`, tries `.ts` when an import names `.js`, and resolves an
// extensionless relative import to `<name>.ts` or `<name>/index.ts`.
// The root arrives through `module.register`'s `data` (see omniroute.ts).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let root = null;

export function initialize(data) {
  root = data?.root ?? null;
}

function firstFile(base) {
  for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), base.replace(/\.js$/, ".ts")]) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      // does not exist: try the next one
    }
  }
  return null;
}

export async function resolve(spec, ctx, next) {
  if (root && spec.startsWith("@/")) {
    const hit = firstFile(path.join(root, "src", spec.slice(2)));
    if (hit) return next(pathToFileURL(hit).href, ctx);
  }
  try {
    return await next(spec, ctx);
  } catch (err) {
    if (spec.endsWith(".js") && ctx.parentURL) return next(spec.replace(/\.js$/, ".ts"), ctx);
    if (spec.startsWith(".") && ctx.parentURL && !path.extname(spec)) {
      const hit = firstFile(path.join(path.dirname(fileURLToPath(ctx.parentURL)), spec));
      if (hit) return next(pathToFileURL(hit).href, ctx);
    }
    throw err;
  }
}
