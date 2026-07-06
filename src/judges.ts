export namespace Judge {
  const DEFAULT_JUDGES = [
    "opencode/claude-sonnet-4-5",
    "opencode/gpt-5-codex",
    "opencode/kimi-k2",
  ];

  // Override the judge panel without editing source, e.g. to route judges
  // through an OpenAI-compatible gateway (see zenModels.ts):
  // OPENCODE_BENCH_JUDGES="anthropic/claude-sonnet-4.5,openai/gpt-5-codex"
  export const all: readonly string[] =
    process.env.OPENCODE_BENCH_JUDGES?.split(",")
      .map((j) => j.trim())
      .filter(Boolean) ?? DEFAULT_JUDGES;
}
