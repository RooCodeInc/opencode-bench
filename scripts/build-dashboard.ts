#!/usr/bin/env bun
/**
 * Builds a self-contained HTML dashboard from a merged results JSON file
 * (as produced by scripts/run-local-matrix.ts). The data is inlined, so the
 * output file can be opened directly or shared as-is.
 *
 * Usage:
 *   bun run scripts/build-dashboard.ts \
 *     --results results/local-matrix.json \
 *     --out results/dashboard.html
 */

import { parseArgs } from "util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Task } from "~/src/tasks/index.js";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    results: { type: "string", default: "results/local-matrix.json" },
    out: { type: "string", default: "results/dashboard.html" },
  },
});

const results = JSON.parse(await readFile(values.results!, "utf-8"));

// Attach reference data (max possible score, reference diff) per task.
const taskMeta: Record<string, { maxScore: number; referenceDiff: string }> =
  {};
for (const name of new Set<string>(results.map((r: any) => r.task))) {
  try {
    const task = await Task.get(name);
    taskMeta[name] = {
      maxScore: task.metrics.reduce((sum, m) => sum + m.weight, 0),
      referenceDiff: task.diff,
    };
  } catch {
    taskMeta[name] = { maxScore: 1, referenceDiff: "" };
  }
}

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>opencode-bench results</title>
<style>
  :root {
    --bg: #0f1117; --panel: #171a23; --border: #262b38; --text: #e2e6ef;
    --muted: #8b93a7; --accent: #6ea8fe; --good: #2fbf71; --mid: #e2b93b; --bad: #e05252;
    font-size: 15px;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 1rem/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; }
  .wrap { max-width: 1200px; margin: 0 auto; padding: 2rem 1.5rem 4rem; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  .sub { color: var(--muted); margin-bottom: 1.5rem; font-size: .9rem; }
  table.matrix { border-collapse: collapse; width: 100%; margin-bottom: 2rem; }
  .matrix th, .matrix td { border: 1px solid var(--border); padding: .5rem .75rem; text-align: center; }
  .matrix th { background: var(--panel); font-weight: 600; font-size: .85rem; }
  .matrix th.task { text-align: left; }
  .matrix td.task { text-align: left; color: var(--muted); font-size: .85rem; }
  .cell { cursor: pointer; font-variant-numeric: tabular-nums; }
  .cell:hover { outline: 2px solid var(--accent); outline-offset: -2px; }
  .cell .eps { display: block; color: var(--muted); font-size: .7rem; }
  .detail { background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
    padding: 1rem 1.25rem; margin-bottom: 1rem; }
  .detail h2 { font-size: 1.05rem; margin: 0 0 .75rem; }
  .ep { border-top: 1px solid var(--border); padding: .75rem 0; }
  .ep-head { display: flex; gap: 1.25rem; flex-wrap: wrap; font-size: .85rem; color: var(--muted); }
  .ep-head b { color: var(--text); }
  .crit { margin: .6rem 0 0 .5rem; }
  .crit-row { display: flex; gap: .6rem; align-items: baseline; flex-wrap: wrap; font-size: .85rem; }
  .crit-name { min-width: 10.5rem; }
  .judge { border: 1px solid var(--border); border-radius: 999px; padding: 0 .55rem;
    font-size: .75rem; cursor: pointer; background: transparent; color: var(--text); }
  .judge.pass { border-color: var(--good); color: var(--good); }
  .judge.fail { border-color: var(--bad); color: var(--bad); }
  .rationale { background: #10131b; border-left: 3px solid var(--accent); margin: .4rem 0 .4rem .5rem;
    padding: .5rem .75rem; font-size: .82rem; color: var(--muted); white-space: pre-wrap; }
  details.diffs { margin-top: .6rem; }
  details.diffs summary { cursor: pointer; color: var(--accent); font-size: .85rem; }
  .diff-cols { display: grid; grid-template-columns: 1fr 1fr; gap: .75rem; margin-top: .5rem; }
  @media (max-width: 900px) { .diff-cols { grid-template-columns: 1fr; } }
  .diff-col h3 { font-size: .8rem; margin: 0 0 .3rem; color: var(--muted); }
  pre.diff { background: #10131b; border: 1px solid var(--border); border-radius: 6px;
    padding: .6rem; overflow-x: auto; font-size: .74rem; max-height: 420px; margin: 0; }
  .legend { color: var(--muted); font-size: .8rem; margin-bottom: 1rem; }
</style>
</head>
<body>
<div class="wrap">
  <h1>opencode-bench results</h1>
  <div class="sub" id="sub"></div>
  <div class="legend">Cells show mean score as % of the task's max possible
    (weights are not normalized upstream). Click a cell for the per-episode judge
    breakdown and the agent's diff vs the shipped production diff.</div>
  <table class="matrix" id="matrix"></table>
  <div id="detail"></div>
</div>
<script>
const RESULTS = ${JSON.stringify(results)};
const TASK_META = ${JSON.stringify(taskMeta)};

const models = [...new Set(RESULTS.map(r => r.model))];
const tasks = [...new Set(RESULTS.map(r => r.task))];
const byCell = {};
for (const r of RESULTS) {
  const k = r.model + "::" + r.task;
  (byCell[k] = byCell[k] || []).push(r);
}

function pct(model, task) {
  const rs = byCell[model + "::" + task];
  if (!rs) return null;
  const max = (TASK_META[task] || {}).maxScore || 1;
  return rs.reduce((s, r) => s + r.score.final, 0) / rs.length / max;
}
function color(p) {
  if (p == null) return "transparent";
  const hue = Math.round(p * 120);
  return "hsl(" + hue + " 55% 22%)";
}

document.getElementById("sub").textContent =
  RESULTS.length + " episodes · " + models.length + " models · " + tasks.length +
  " tasks · judges: " + [...new Set(RESULTS.flatMap(r =>
    r.scoreDetails.flatMap(s => s.judges.map(j => j.judge))))].join(", ");

const matrix = document.getElementById("matrix");
let head = "<tr><th class='task'>task</th>" + models.map(m =>
  "<th>" + m.replace("openrouter/", "") + "</th>").join("") + "</tr>";
let rows = tasks.map(t => {
  const cells = models.map(m => {
    const p = pct(m, t);
    const rs = byCell[m + "::" + t] || [];
    if (p == null) return "<td class='cell'>–</td>";
    return "<td class='cell' style='background:" + color(p) + "' " +
      "onclick='showDetail(" + JSON.stringify(m) + "," + JSON.stringify(t) + ")'>" +
      (p * 100).toFixed(0) + "%<span class='eps'>" + rs.length + " ep · $" +
      (rs.reduce((s, r) => s + r.usage.cost, 0)).toFixed(2) + "</span></td>";
  }).join("");
  return "<tr><td class='task'>" + t + "</td>" + cells + "</tr>";
}).join("");
// Model averages across tasks (only over cells that exist)
const avgCells = models.map(m => {
  const ps = tasks.map(t => pct(m, t)).filter(p => p != null);
  if (!ps.length) return "<td>–</td>";
  const avg = ps.reduce((a, b) => a + b, 0) / ps.length;
  return "<td style='background:" + color(avg) + "'><b>" + (avg * 100).toFixed(0) + "%</b></td>";
}).join("");
matrix.innerHTML = head + rows +
  "<tr><td class='task'><b>model average</b></td>" + avgCells + "</tr>";

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

window.showDetail = (model, task) => {
  const rs = byCell[model + "::" + task];
  const meta = TASK_META[task] || { maxScore: 1, referenceDiff: "" };
  const el = document.getElementById("detail");
  el.innerHTML = "<div class='detail'><h2>" + esc(task) + " · " + esc(model) +
    "</h2>" + rs.map((r, i) => {
      const crits = r.scoreDetails.map((s, si) => {
        const judges = s.judges.map((j, ji) =>
          "<button class='judge " + (j.score >= 0.5 ? "pass" : "fail") + "' " +
          "onclick='toggleRationale(" + i + "," + si + "," + ji + ")'>" +
          esc(j.judge.split("/").pop()) + " " + j.score.toFixed(2) + "</button>"
        ).join(" ");
        const rats = s.judges.map((j, ji) => {
          const items = (j.checklist || []).map(c =>
            "<div>" + (c.satisfied ? "✓" : "✗") + " " + esc(c.item) + "</div>"
          ).join("");
          return "<div class='rationale' id='rat-" + i + "-" + si + "-" + ji +
            "' style='display:none'><b>" + esc(j.judge) + ":</b> " +
            esc(j.rationale || "(no rationale)") +
            (items ? "<div style='margin-top:.4rem'>" + items + "</div>" : "") +
            "</div>";
        }).join("");
        return "<div class='crit'><div class='crit-row'><span class='crit-name'>" +
          esc(s.criterion) + " (w " + s.weight + ")</span>" + judges +
          (s.variance > 0.02 ? " <span style='color:var(--mid)'>disagreement</span>" : "") +
          "</div>" + rats + "</div>";
      }).join("");
      const diffs = (r.diff || meta.referenceDiff) ?
        "<details class='diffs'><summary>agent diff vs production diff</summary>" +
        "<div class='diff-cols'><div class='diff-col'><h3>agent</h3><pre class='diff'>" +
        esc(r.diff || "(not captured in this run)") +
        "</pre></div><div class='diff-col'><h3>production (reference)</h3><pre class='diff'>" +
        esc(meta.referenceDiff || "(unavailable)") + "</pre></div></div></details>" : "";
      return "<div class='ep'><div class='ep-head'>" +
        "<span>episode <b>" + r.episode + "</b></span>" +
        "<span>score <b>" + r.score.final.toFixed(3) + "</b> / " + meta.maxScore.toFixed(1) +
        " (base " + r.score.base.toFixed(3) + " − penalty " + r.score.penalty.toFixed(3) + ")</span>" +
        "<span>cost <b>$" + r.usage.cost.toFixed(2) + "</b></span>" +
        "<span>duration <b>" + Math.round(r.duration / 1000) + "s</b></span>" +
        "</div>" + crits + diffs + "</div>";
    }).join("") + "</div>";
  el.scrollIntoView({ behavior: "smooth" });
};

window.toggleRationale = (i, si, ji) => {
  const el = document.getElementById("rat-" + i + "-" + si + "-" + ji);
  el.style.display = el.style.display === "none" ? "block" : "none";
};
</script>
</body>
</html>
`;

await mkdir(dirname(values.out!), { recursive: true });
await writeFile(values.out!, html);
console.log(`Dashboard written to ${values.out}`);
