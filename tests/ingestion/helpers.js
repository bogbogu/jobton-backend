// Shared test helpers for the ingestion tests. Nothing here touches the
// network or the real Anthropic API.

export const escapeHtml = (value) =>
  String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Builds a t.me/s style page. `posts`: [{ id, text, date, image }]
// `image` is true (a photo wrap without a URL) or an array of photo URLs.
export function makePage(channel, posts) {
  const wraps = posts
    .map((post) => {
      const body = post.text
        ? `<div class="tgme_widget_message_text js-message_text" dir="auto">${escapeHtml(post.text).replace(/\n/g, "<br/>")}</div>`
        : "";
      const photo = (url) =>
        `<a class="tgme_widget_message_photo_wrap" href="#" style="width:800px;background-image:url('${url}')"></a>`;
      const image = Array.isArray(post.image)
        ? post.image.map(photo).join("")
        : post.image
          ? '<a class="tgme_widget_message_photo_wrap" href="#"></a>'
          : "";
      const date = post.date || "2026-10-01T08:00:00+00:00";
      return `<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message js-widget_message" data-post="${channel}/${post.id}"><div class="tgme_widget_message_bubble">${image}${body}<div class="tgme_widget_message_footer"><span class="tgme_widget_message_meta"><a class="tgme_widget_message_date" href="https://t.me/${channel}/${post.id}"><time datetime="${date}">x</time></a></span></div></div></div></div>`;
    })
    .join("\n");
  return `<!DOCTYPE html><html><body><main class="tgme_channel_history">${wraps}</main></body></html>`;
}

export const htmlResponse = (html, init = {}) =>
  new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, ...init });

// A fake fetch serving pages from a map: url -> html (or a Response factory).
// Records every requested URL in `fake.calls`.
export function makeFakeFetch(routes) {
  const calls = [];
  const fake = async (url, options) => {
    calls.push({ url: String(url), options });
    const route = routes[String(url)];
    // An older page nobody configured: Telegram answers with an empty page.
    if (route === undefined && String(url).includes("?before=")) return htmlResponse("<html><body></body></html>");
    if (route === undefined) return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
    if (route instanceof Error) throw route;
    if (typeof route === "function") return route();
    return htmlResponse(route);
  };
  fake.calls = calls;
  return fake;
}

export const baseJob = (overrides = {}) => ({
  title: "Accountant",
  company: "Acme Nigeria Ltd",
  location: "Lagos",
  employmentType: "Unknown",
  workArrangement: "Unknown",
  salaryMin: null,
  salaryMax: null,
  salaryCurrency: "Unknown",
  salaryPeriod: "Unknown",
  category: "Finance",
  skills: [],
  experience: null,
  qualification: null,
  description: "An accountant role.",
  responsibilities: [],
  aboutCompany: "",
  requirements: [],
  benefits: [],
  applicationLink: null,
  applyEmail: null,
  applyPhone: null,
  corrections: [],
  ...overrides,
});

// A fake Anthropic client. `respond(args, callIndex)` returns the parsed_output
// (or throws). Every call's arguments are kept in `client.calls`.
export function makeFakeClient(respond) {
  const calls = [];
  const client = {
    calls,
    messages: {
      parse: async (args) => {
        calls.push(args);
        const parsed_output = await respond(args, calls.length - 1);
        return {
          stop_reason: "end_turn",
          parsed_output,
          usage: { input_tokens: 100, output_tokens: 50 },
        };
      },
    },
  };
  return client;
}

export const jobResponse = (jobOverrides = {}, extra = {}) => ({
  isJobPost: true,
  notJobReason: null,
  jobs: [baseJob(jobOverrides)],
  redFlags: [],
  ...extra,
});

export const testConfig = (overrides = {}) => ({
  enabled: true,
  model: "claude-haiku-5-5",
  dailyLlmCap: 300,
  maxPostsPerChannelRun: 40,
  maxPagesPerChannel: 3,
  maxPendingPerChannel: 200,
  fetchDelayMs: 0,
  requestTimeoutMs: 10_000,
  maxResponseBytes: 2 * 1024 * 1024,
  maxPostTextChars: 4000,
  llmMaxTokens: 2000,
  imagesEnabled: false,
  imageMinTextChars: 400,
  maxImagesPerPost: 2,
  imageMaxTokens: 4000,
  ...overrides,
});

export const silentLog = () => {};
