#!/usr/bin/env bun
/**
 * Self-hosted bench UI: launch model x task x episode runs and browse results
 * without any tooling beyond a browser.
 *
 *   bun run ui          # http://127.0.0.1:4700
 *
 * Env (bun auto-loads .env/.env.local): the same variables the CLI uses,
 * plus HOST/PORT for the server itself. No auth — keep it on localhost or
 * behind a private network.
 */

import { join, resolve } from "node:path";
import { readdir, readFile, mkdir } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

const ROOT = resolve(import.meta.dir, "..");
const RESULTS_DIR = join(ROOT, "results");
const TASKS_DIR = join(ROOT, "src", "tasks");
const PUBLIC_DIR = join(ROOT, "server", "public");
const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? 4700);
// Staggered shard starts: concurrent opencode SDK servers race on detectPort.
const SHARD_STAGGER_MS = Number(process.env.SHARD_STAGGER_MS ?? 30_000);

await mkdir(RESULTS_DIR, { recursive: true });

// ---------- tasks ----------

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

async function listTasks() {
  const folders = await readdir(TASKS_DIR, { withFileTypes: true });
  const out: { name: string; repo: string; maxScore: number }[] = [];
  for (const f of folders) {
    if (!f.isDirectory() || f.name.startsWith("_")) continue;
    try {
      const def = parseYaml(
        await readFile(join(TASKS_DIR, f.name, "definition.yml"), "utf-8"),
      );
      out.push({
        name: f.name,
        repo: def.source.repo,
        maxScore: def.metrics.reduce(
          (s: number, m: { weight: number }) => s + m.weight,
          0,
        ),
      });
    } catch {
      // folder without a valid definition — skip
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function referenceDiff(name: string) {
  if (!NAME_RE.test(name)) throw new Error("bad task name");
  return await readFile(join(TASKS_DIR, name, "diff.patch"), "utf-8");
}

// ---------- results ----------

type Row = Record<string, any>;

async function mergedResults(): Promise<Row[]> {
  const files = (await readdir(RESULTS_DIR).catch(() => [])).filter((f) =>
    f.endsWith(".json"),
  );
  const seen = new Set<string>();
  const rows: Row[] = [];
  for (const f of files) {
    let data: unknown;
    try {
      data = JSON.parse(await readFile(join(RESULTS_DIR, f), "utf-8"));
    } catch {
      continue; // partially written or foreign file
    }
    if (!Array.isArray(data)) continue;
    for (const r of data) {
      if (!r?.model || !r?.task || !r?.score) continue;
      const key = `${r.model}::${r.task}::${r.episode ?? 1}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(r);
    }
  }
  return rows;
}

function stripHeavy(r: Row): Row {
  const { diff, actions, ...rest } = r;
  return { ...rest, diffChars: typeof diff === "string" ? diff.length : 0 };
}

// ---------- runs ----------

interface Shard {
  model: string;
  outFile: string;
  logFile: string;
  status: "pending" | "running" | "done" | "failed" | "stopped";
  pid?: number;
}

interface Run {
  id: string;
  models: string[];
  tasks: string[];
  episodes: number;
  startedAt: string;
  stopped: boolean;
  shards: Shard[];
}

const runs = new Map<string, Run>();
const procs = new Map<string, ReturnType<typeof Bun.spawn>>();
let runSeq = 0;

function fileSuffix(model: string) {
  return model.replace(/[^a-zA-Z0-9.]+/g, "-");
}

function launchRun(models: string[], tasks: string[], episodes: number): Run {
  const id = `run${++runSeq}-${Date.now().toString(36)}`;
  const run: Run = {
    id,
    models,
    tasks,
    episodes,
    startedAt: new Date().toISOString(),
    stopped: false,
    shards: models.map((model) => ({
      model,
      outFile: join(RESULTS_DIR, `ui-${fileSuffix(model)}.json`),
      logFile: join(RESULTS_DIR, `ui-${fileSuffix(model)}.log`),
      status: "pending",
    })),
  };
  runs.set(id, run);

  (async () => {
    for (const shard of run.shards) {
      if (run.stopped) {
        shard.status = "stopped";
        continue;
      }
      const cmd = [
        `export PATH="${ROOT}/node_modules/.bin:$PATH";`,
        `exec bun run scripts/run-local-matrix.ts`,
        `--models "${shard.model}"`,
        `--tasks "${tasks.join(",")}"`,
        `--episodes ${episodes}`,
        `--out "${shard.outFile}"`,
        `>> "${shard.logFile}" 2>&1`,
      ].join(" ");
      const proc = Bun.spawn(["bash", "-c", cmd], {
        cwd: ROOT,
        env: {
          ...(process.env as Record<string, string>),
          // Register the run's models with the agent so free-text model IDs
          // from the UI pass the runner's allowlist.
          OPENCODE_BENCH_EXTRA_MODELS: [
            process.env.OPENCODE_BENCH_EXTRA_MODELS ?? "",
            ...run.models,
          ]
            .filter(Boolean)
            .join(","),
        },
      });
      shard.status = "running";
      shard.pid = proc.pid;
      procs.set(`${id}::${shard.model}`, proc);
      proc.exited.then((code) => {
        if (shard.status === "running")
          shard.status = code === 0 ? "done" : "failed";
        procs.delete(`${id}::${shard.model}`);
      });
      if (shard !== run.shards[run.shards.length - 1])
        await new Promise((r) => setTimeout(r, SHARD_STAGGER_MS));
    }
  })();

  return run;
}

function stopRun(run: Run) {
  run.stopped = true;
  for (const shard of run.shards) {
    const proc = procs.get(`${run.id}::${shard.model}`);
    if (proc) {
      proc.kill();
      shard.status = "stopped";
    } else if (shard.status === "pending") {
      shard.status = "stopped";
    }
  }
}

async function runProgress(run: Run) {
  const shards = [];
  for (const shard of run.shards) {
    let done = 0;
    try {
      const data = JSON.parse(await readFile(shard.outFile, "utf-8"));
      if (Array.isArray(data))
        done = data.filter(
          (r: Row) =>
            run.tasks.includes(r.task) && (r.episode ?? 1) <= run.episodes,
        ).length;
    } catch {
      // out file not written yet
    }
    let logTail = "";
    try {
      const log = await readFile(shard.logFile, "utf-8");
      logTail = log.slice(-400).split("\n").filter(Boolean).slice(-2).join("\n");
    } catch {}
    shards.push({
      ...shard,
      done,
      total: run.tasks.length * run.episodes,
      logTail,
    });
  }
  return { ...run, shards };
}

// ---------- spend ----------

async function spend() {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) return { usage: null };
  const res = await fetch("https://openrouter.ai/api/v1/key", {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) return { usage: null };
  const data = (await res.json()) as { data: { usage: number } };
  return { usage: data.data.usage };
}

// ---------- http ----------

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      if (path === "/" || path === "/index.html") {
        return new Response(
          await readFile(join(PUBLIC_DIR, "index.html")),
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }

      if (path === "/api/tasks") return json(await listTasks());

      if (path === "/api/models") {
        const models = (process.env.OPENCODE_BENCH_EXTRA_MODELS ?? "")
          .split(",")
          .map((m) => m.trim())
          .filter(Boolean);
        return json(models);
      }

      if (path === "/api/results") {
        return json((await mergedResults()).map(stripHeavy));
      }

      if (path === "/api/cell") {
        const model = url.searchParams.get("model") ?? "";
        const task = url.searchParams.get("task") ?? "";
        const rows = (await mergedResults()).filter(
          (r) => r.model === model && r.task === task,
        );
        return json(rows);
      }

      if (path.startsWith("/api/reference-diff/")) {
        const name = path.split("/").pop() ?? "";
        return new Response(await referenceDiff(name), {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }

      if (path === "/api/spend") return json(await spend());

      if (path === "/api/runs" && req.method === "GET") {
        const out = [];
        for (const run of runs.values()) out.push(await runProgress(run));
        return json(out.reverse());
      }

      if (path === "/api/runs" && req.method === "POST") {
        const body = (await req.json()) as {
          models?: string[];
          tasks?: string[];
          episodes?: number;
        };
        const MODEL_RE = /^[a-zA-Z0-9._/-]+$/;
        const models = (body.models ?? [])
          .map((m) => m.trim())
          .filter((m) => m && MODEL_RE.test(m));
        const tasks = (body.tasks ?? []).filter((t) => NAME_RE.test(t));
        const episodes = Math.min(Math.max(Number(body.episodes) || 1, 1), 10);
        if (!models.length) return json({ error: "no models" }, 400);
        if (!tasks.length) return json({ error: "no tasks" }, 400);
        const run = launchRun(models, tasks, episodes);
        return json({ id: run.id });
      }

      const stopMatch = path.match(/^\/api\/runs\/([a-z0-9-]+)\/stop$/);
      if (stopMatch && req.method === "POST") {
        const run = runs.get(stopMatch[1]);
        if (!run) return json({ error: "not found" }, 404);
        stopRun(run);
        return json({ ok: true });
      }

      return new Response("not found", { status: 404 });
    } catch (e) {
      return json(
        { error: e instanceof Error ? e.message : String(e) },
        500,
      );
    }
  },
});

console.log(`bench ui listening on http://${HOST}:${server.port}`);
