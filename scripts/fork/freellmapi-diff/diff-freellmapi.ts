#!/usr/bin/env node
/**
 * Diff FreeLLMAPI's public model catalog against the OmniRoute catalog.
 * Usage and rationale: README.md in this folder.
 *
 *   node scripts/fork/freellmapi-diff/diff-freellmapi.ts --out <dir>
 *        [--omniroute <repo root>] [--page <models.html>] [--data <data.js>]
 *        [--map <json>] [--tolerance 1.5] [--pause-ms 1500]
 *
 * Read-only: two GET requests to freellmapi.co (the /models page and the
 * data.js it loads), with a pause between them. 403 or 429 stops the read
 * (exit code 3). No token, no login, no paid feed.
 * Writes only under --out: diff.md, diff.json and raw/.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { computeDiff, extractDataUrl, extractSnapshot, normalizeFree, renderMarkdown } from "./lib.ts";
import { readOmniRouteCatalog } from "./omniroute.ts";

export const MODELS_URL = "https://freellmapi.co/models";
const ORIGIN = new URL(MODELS_URL).origin;
const USER_AGENT = "catalog-diff/1.0 (public read, 2 requests per run)";

export class PoliteStop extends Error {}

export async function fetchText(url: string): Promise<string> {
  if (new URL(url).origin !== ORIGIN) throw new Error(`origin outside ${ORIGIN}: ${url}`);
  const r = await fetch(url, { headers: { "user-agent": USER_AGENT }, redirect: "error" });
  if (r.status === 403 || r.status === 429) {
    throw new PoliteStop(`HTTP ${r.status} on ${url}: stopping the read`);
  }
  if (!r.ok) throw new Error(`HTTP ${r.status} on ${url}`);
  return await r.text();
}

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      omniroute: { type: "string" },
      page: { type: "string" },
      data: { type: "string" },
      map: { type: "string" },
      tolerance: { type: "string", default: "1.5" },
      "pause-ms": { type: "string", default: "1500" },
    },
  });
  if (!values.out) {
    console.error("usage: --out <dir> is required (see this folder's README)");
    return 2;
  }
  const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const omniRoot = values.omniroute ?? defaultRoot;
  const tolerance = Number(values.tolerance);
  const pause = Number(values["pause-ms"]);

  let html: string;
  let js: string;
  if (values.data) {
    js = fs.readFileSync(values.data, "utf8");
    html = values.page ? fs.readFileSync(values.page, "utf8") : "";
  } else {
    html = values.page ? fs.readFileSync(values.page, "utf8") : await fetchText(MODELS_URL);
    const dataUrl = extractDataUrl(html, MODELS_URL);
    if (!dataUrl) throw new Error("the /models page does not reference /assets/data.js: the format changed");
    if (!values.page) await sleep(pause);
    js = await fetchText(dataUrl);
  }

  const free = normalizeFree(extractSnapshot(js));
  const omni = await readOmniRouteCatalog(omniRoot);
  const map = values.map ? (JSON.parse(fs.readFileSync(values.map, "utf8")) as Record<string, string[]>) : undefined;
  const res = computeDiff(free, omni, {
    map,
    tokensMonthTolerance: tolerance,
    freellmapiUrl: values.data ? null : MODELS_URL,
  });

  fs.mkdirSync(path.join(values.out, "raw"), { recursive: true });
  if (html) fs.writeFileSync(path.join(values.out, "raw", "models.html"), html);
  fs.writeFileSync(path.join(values.out, "raw", "data.js"), js);
  fs.writeFileSync(path.join(values.out, "diff.json"), JSON.stringify(res, null, 2));
  fs.writeFileSync(path.join(values.out, "diff.md"), renderMarkdown(res, free));

  const s = res.scoreboard;
  console.log(
    `freellmapi ${res.sources.freellmapi.version}: ${s.freellmapiProviders} providers (${s.missingProviders} missing), ` +
      `${s.freellmapiModels} models (${s.presentModels} present, ${s.missingModels} missing, ` +
      `${s.missingFromStaticModels} not in a live provider's static list, ${s.providerMissingModels} of a missing provider), ` +
      `${s.divergentQuotas} divergent quotas in ${s.modelsWithDivergentQuota} models, ` +
      `${s.missingAndNoTraining} missing and known not to train`
  );
  console.log(`output: ${path.resolve(values.out)}`);
  return 0;
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) {
  main().then(
    (c) => process.exit(c),
    (e) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(e instanceof PoliteStop ? 3 : 1);
    }
  );
}
