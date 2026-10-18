// Ingestion settings, read from the environment at CALL time (not import
// time) so tests and the cron script can set them before running.
//
// The API key is attached as a NON-enumerable property: logging or
// JSON.stringify-ing the config can therefore never print it.

const DEFAULTS = {
  model: "claude-haiku-5-5",
  dailyLlmCap: 300,
  maxPostsPerChannelRun: 40,
  maxPagesPerChannel: 3,
  maxPendingPerChannel: 200,
  fetchDelayMs: 2000,
};

const readInt = (name, fallback, { min = 0 } = {}) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min ? value : fallback;
};

export function getConfig() {
  const config = {
    enabled: process.env.INGESTION_ENABLED === "true",
    model: (process.env.INGESTION_MODEL || "").trim() || DEFAULTS.model,
    dailyLlmCap: readInt("INGESTION_DAILY_LLM_CAP", DEFAULTS.dailyLlmCap),
    maxPostsPerChannelRun: readInt("INGESTION_MAX_POSTS_PER_CHANNEL_RUN", DEFAULTS.maxPostsPerChannelRun),
    maxPagesPerChannel: readInt("INGESTION_MAX_PAGES_PER_CHANNEL", DEFAULTS.maxPagesPerChannel, { min: 1 }),
    maxPendingPerChannel: readInt("INGESTION_MAX_PENDING_PER_CHANNEL", DEFAULTS.maxPendingPerChannel),
    fetchDelayMs: readInt("INGESTION_FETCH_DELAY_MS", DEFAULTS.fetchDelayMs),
    requestTimeoutMs: 10_000,
    maxResponseBytes: 2 * 1024 * 1024,
    maxPostTextChars: 4000,
    llmMaxTokens: 2000,
  };

  Object.defineProperty(config, "anthropicApiKey", {
    value: process.env.ANTHROPIC_API_KEY || "",
    enumerable: false,
  });

  return config;
}
