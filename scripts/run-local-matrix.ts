#!/usr/bin/env bun
/**
 * Runs a models x tasks x episodes matrix locally and writes all results
 * to a single merged JSON file (incrementally, so partial runs are usable).
 *
 * Usage:
 *   bun run scripts/run-local-matrix.ts \
 *     --models openrouter/openai/gpt-5.4,openrouter/anthropic/claude-sonnet-4.5 \
 *     --tasks sst-opencode-formatting,cal-com-example \
 *     --episodes 2 \
 *     --out results/local-matrix.json
 */

import { parseArgs } from "util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Agent } from "~/src/agents/index.js";
import { Task } from "~/src/tasks/index.js";
import { Eval } from "~/src/eval.js";
import { Logger } from "~/src/util/logger.js";
import { fileExists } from "~/src/util/fs.js";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    agent: { type: "string", default: "opencode" },
    models: { type: "string" },
    tasks: { type: "string" },
    episodes: { type: "string", default: "1" },
    out: { type: "string", default: "results/local-matrix.json" },
  },
});

if (!values.models) {
  console.error("Error: --models is required (comma-separated)");
  process.exit(1);
}

const models = values.models.split(",").map((m) => m.trim()).filter(Boolean);
const tasks = values.tasks
  ? values.tasks.split(",").map((t) => t.trim()).filter(Boolean)
  : await Task.listNames();
const episodes = Number.parseInt(values.episodes!, 10);
const outPath = values.out!;

type StoredResult = Eval.Result & { episode: number; completedAt: string };

// Resume support: keep prior results, skip cells that already have this episode.
let results: StoredResult[] = [];
if (await fileExists(outPath)) {
  results = JSON.parse(await readFile(outPath, "utf-8"));
  console.log(`Resuming: ${results.length} existing results in ${outPath}`);
}
const done = new Set(results.map((r) => `${r.model}::${r.task}::${r.episode}`));

await mkdir(dirname(outPath), { recursive: true });

const total = models.length * tasks.length * episodes;
let n = 0;
for (const model of models) {
  for (const task of tasks) {
    for (let episode = 1; episode <= episodes; episode++) {
      n++;
      const key = `${model}::${task}::${episode}`;
      if (done.has(key)) {
        console.log(`[${n}/${total}] skip (done): ${key}`);
        continue;
      }
      console.log(`[${n}/${total}] running: ${key}`);
      try {
        const result = await Eval.run(values.agent!, model, task, {
          logger: Logger.create(`[${model} ${task} ep${episode}]`),
        });
        results.push({
          ...result,
          episode,
          completedAt: new Date().toISOString(),
        });
      } catch (e) {
        console.error(
          `FAILED ${key}: ${e instanceof Error ? e.message : String(e)}`,
        );
        continue;
      }
      await writeFile(outPath, JSON.stringify(results, null, 2));
    }
  }
}

console.log(`Wrote ${results.length} results to ${outPath}`);

for (const agent of Agent.list()) {
  if (agent.definition.cleanup) await agent.definition.cleanup();
}
process.exit();
