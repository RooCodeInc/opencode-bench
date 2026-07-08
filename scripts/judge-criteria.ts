#!/usr/bin/env bun
/**
 * Judge criterion-based eval bundles and append the results to a results
 * file the dashboard/UI already understands.
 *
 * A bundle is produced by an external scenario runner (e.g. a
 * chat-integration test harness) and looks like:
 *   {
 *     "name": "slack-thread-mention-creates-issue",
 *     "target": "myagent@develop",
 *     "episode": 1,
 *     "criteria": ["Exactly one acknowledgment is posted in the thread", ...],
 *     "artifacts": { "slack_transcript": "...", "task_diff": "..." },
 *     "duration": 123456
 *   }
 *
 * Usage:
 *   bun run scripts/judge-criteria.ts --input bundle.json --out results/slack-evals.json
 *   bun run scripts/judge-criteria.ts --input bundles-dir/ --out results/slack-evals.json
 */

import { parseArgs } from "util";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Criteria } from "~/src/criteria.js";
import { Logger } from "~/src/util/logger.js";
import { fileExists } from "~/src/util/fs.js";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    input: { type: "string" },
    out: { type: "string", default: "results/criteria.json" },
  },
});

if (!values.input) {
  console.error("Error: --input <bundle.json | directory> is required");
  process.exit(1);
}

const inputs: string[] = [];
if ((await stat(values.input)).isDirectory()) {
  for (const f of await readdir(values.input)) {
    if (f.endsWith(".json")) inputs.push(join(values.input, f));
  }
  inputs.sort();
} else {
  inputs.push(values.input);
}
if (!inputs.length) {
  console.error(`No bundle files found in ${values.input}`);
  process.exit(1);
}

type StoredResult = Awaited<ReturnType<typeof Criteria.evaluate>>;
let results: StoredResult[] = [];
if (await fileExists(values.out!)) {
  results = JSON.parse(await readFile(values.out!, "utf-8"));
}
const keyOf = (r: { model: string; task: string; episode?: number }) =>
  `${r.model}::${r.task}::${r.episode ?? 1}`;
const done = new Set(results.map(keyOf));

await mkdir(dirname(values.out!), { recursive: true });

for (const file of inputs) {
  const bundle = JSON.parse(await readFile(file, "utf-8"));
  const logger = Logger.create(`[${bundle.name ?? file}]`);
  const result = await Criteria.evaluate(bundle, { logger });
  const key = keyOf(result);
  if (done.has(key)) {
    // Re-judging the same cell replaces the previous verdict.
    results = results.filter((r) => keyOf(r) !== key);
  }
  done.add(key);
  results.push(result);
  logger.log(
    `Score: ${result.score.final.toFixed(3)} (base ${result.score.base.toFixed(3)} - penalty ${result.score.penalty.toFixed(3)})`,
  );
  await writeFile(values.out!, JSON.stringify(results, null, 2));
}

console.log(`Wrote ${results.length} results to ${values.out}`);
process.exit(0);
