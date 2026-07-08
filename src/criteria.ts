import { z } from "zod";
import { generateObject } from "ai";
import { Judge } from "./judges.js";
import { getZenLanguageModel } from "./zenModels.js";
import { average, variance } from "./util/math.js";
import { Logger } from "./util/logger.js";

/**
 * Criterion-based evaluation: the eval author writes explicit success
 * criteria, and the judge panel verifies each one against the artifacts a
 * run produced (Slack transcripts, code diffs, timing — anything).
 *
 * This complements the repo-task evals, where checklists are derived from a
 * reference diff: here the checklist IS the eval definition, so behavior
 * evals (e.g. "how Roomote uses Slack") state intent directly and let
 * implementations vary.
 */
export namespace Criteria {
  export const DISAGREEMENT_PENALTY = 0.5;

  export const bundleSchema = z.object({
    /** Scenario name — becomes the task axis in results (kebab-case). */
    name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    /** What is being evaluated (model, prompt version, branch) — becomes the model axis. */
    target: z.string().min(1),
    agent: z.string().default("roomote"),
    episode: z.number().int().positive().default(1),
    /** Authored success criteria: concrete, independently checkable facts. */
    criteria: z.array(z.string().min(1)).min(1).max(25),
    /** Named evidence blobs the producer captured (already truncated as needed). */
    artifacts: z.record(z.string(), z.string()),
    usage: z
      .object({
        input: z.number().default(0),
        output: z.number().default(0),
        cost: z.number().default(0),
      })
      .default({ input: 0, output: 0, cost: 0 }),
    /** Wall-clock duration of the evaluated run, ms. */
    duration: z.number().default(0),
  });
  export type Bundle = z.input<typeof bundleSchema>;

  const systemPrompt = `You are verifying whether a run of an autonomous agent satisfied a list of authored acceptance criteria.

You are given:
1. The CRITERIA — each is a concrete, independently checkable expectation written by the eval author. They are the source of truth.
2. The ARTIFACTS — evidence captured from the run (message transcripts, code diffs, timing data, etc).

For EACH criterion, decide whether the evidence shows it was satisfied:
- Judge ONLY against the provided artifacts. Do not assume behavior that is not evidenced.
- If a criterion cannot be verified from the artifacts (missing evidence), mark it NOT satisfied and say what evidence was missing.
- Judge every criterion exactly as written — do not add, merge, drop, or reinterpret criteria.
- Each judgment is strictly binary: satisfied or not.

Return JSON with 'checklist' — one object per criterion IN THE SAME ORDER, each {"item": <the criterion text>, "satisfied": <boolean>} — and 'rationale' summarizing the most important failures (or confirming all criteria passed), citing specific evidence.`;

  function userPrompt(bundle: z.output<typeof bundleSchema>) {
    const criteria = bundle.criteria
      .map((c, i) => `${i + 1}. ${c}`)
      .join("\n");
    const artifacts = Object.entries(bundle.artifacts)
      .map(([name, body]) => `### ${name}\n${body}`)
      .join("\n\n");
    return `CRITERIA:\n${criteria}\n\nARTIFACTS:\n\n${artifacts}\n\nJudge each criterion against the artifacts. Respond with JSON.`;
  }

  async function judgeOnce(
    judge: string,
    bundle: z.output<typeof bundleSchema>,
    opts: { logger: Logger.Instance },
  ) {
    const { object } = await generateObject({
      model: getZenLanguageModel(judge),
      schema: z.object({
        checklist: z
          .array(
            z.object({
              item: z.string().min(1),
              satisfied: z.boolean(),
            }),
          )
          .min(1),
        rationale: z.string().min(1),
      }),
      system: systemPrompt,
      temperature: 0,
      prompt: userPrompt(bundle),
    });
    // Force alignment with the authored criteria: same count, same order.
    const checklist = bundle.criteria.map((item, i) => ({
      item,
      satisfied: object.checklist[i]?.satisfied ?? false,
    }));
    const satisfied = checklist.filter((c) => c.satisfied).length;
    const result = {
      score: satisfied / checklist.length,
      rationale: object.rationale,
      checklist,
    };
    opts.logger.log("Judge result:", {
      judge,
      score: result.score,
      rationale: result.rationale,
    });
    return result;
  }

  /** Judge a bundle with the full panel; returns a runner-compatible Result. */
  export async function evaluate(
    input: Bundle,
    opts: { logger: Logger.Instance },
  ) {
    const bundle = bundleSchema.parse(input);
    const scores = [];
    for (const judge of Judge.all) {
      const jl = opts.logger.child(`[judge ${judge}]`);
      let result;
      try {
        result = await judgeOnce(judge, bundle, { logger: jl });
      } catch (e: any) {
        jl.error("Failed to judge:", e?.message ?? e);
        result = {
          score: 0,
          rationale: `Judge error: ${e?.message ?? e}`,
          checklist: [],
        };
      }
      scores.push({ ...result, judge });
    }

    const avg = average(scores.map((s) => s.score));
    const vrc = variance(
      avg,
      scores.map((s) => s.score),
    );
    const penalty = DISAGREEMENT_PENALTY * vrc;
    const final = Math.max(0, avg - penalty);

    return {
      task: bundle.name,
      model: bundle.target,
      agent: bundle.agent,
      diff: bundle.artifacts.task_diff ?? "",
      score: { final, base: avg, penalty },
      scoreDetails: [
        {
          criterion: "criteria",
          weight: 1,
          average: avg,
          variance: vrc,
          judges: scores,
        },
      ],
      actions: [] as string[],
      usage: bundle.usage,
      duration: bundle.duration,
      episode: bundle.episode,
      completedAt: new Date().toISOString(),
    };
  }
}
