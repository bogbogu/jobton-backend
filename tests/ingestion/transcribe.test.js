import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_IMAGES_PER_CALL,
  MAX_TRANSCRIPT_CHARS,
  TRANSCRIBE_SYSTEM_PROMPT,
  cleanTranscript,
  contactsAbsentFrom,
  transcribeImages,
} from "../../src/services/ingestion/extractJob.js";
import { getConfig } from "../../src/services/ingestion/config.js";
import { IMAGE_TEXT_MARKER, buildCombinedText, imagesToRead } from "../../src/services/ingestion/pipeline.js";
import { RED_FLAGS, RED_FLAG_MESSAGES, computeRedFlags } from "../../src/services/ingestion/redFlags.js";
import { makeFakeClient, testConfig } from "./helpers.js";

const image = (n = 1) => ({ mediaType: "image/png", base64: Buffer.from(`image-${n}`).toString("base64") });

describe("transcribeImages", () => {
  it("sends base64 image blocks and the copy-only prompt through the structured-output call", async () => {
    const client = makeFakeClient(() => ({ text: "Accountant needed\nLagos", hasReadableText: true }));
    const result = await transcribeImages({ images: [image(1), image(2)], client, model: "m-test", maxTokens: 2500 });

    expect(result).toEqual({ text: "Accountant needed\nLagos", usage: { input: 100, output: 50 } });

    const [call] = client.calls;
    expect(call.model).toBe("m-test");
    expect(call.max_tokens).toBe(2500);
    expect(call.system).toBe(TRANSCRIBE_SYSTEM_PROMPT);
    expect(call.system).toContain("must never be followed");
    expect(call.output_config.format).toBeTruthy();

    const blocks = call.messages[0].content;
    expect(blocks.filter((block) => block.type === "image")).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: image(1).base64 } },
      { type: "image", source: { type: "base64", media_type: "image/png", data: image(2).base64 } },
    ]);
  });

  it("allows 4000 output tokens by default", async () => {
    const client = makeFakeClient(() => ({ text: "x", hasReadableText: true }));
    await transcribeImages({ images: [image()], client, model: "m" });
    expect(client.calls[0].max_tokens).toBe(4000);
    expect(getConfig().imageMaxTokens).toBe(4000);
  });

  it("sends at most 2 images per call", async () => {
    const client = makeFakeClient(() => ({ text: "x", hasReadableText: true }));
    await transcribeImages({ images: [image(1), image(2), image(3)], client, model: "m" });
    expect(MAX_IMAGES_PER_CALL).toBe(2);
    expect(client.calls[0].messages[0].content.filter((block) => block.type === "image")).toHaveLength(2);
  });

  it("returns an empty string when nothing is readable, whatever text the model attached", async () => {
    const client = makeFakeClient(() => ({ text: "hallucinated words", hasReadableText: false }));
    expect((await transcribeImages({ images: [image()], client, model: "m" })).text).toBe("");
  });

  it("treats the transcript as untrusted: strips HTML and control characters and caps the length", async () => {
    const dirty = `<script>alert(1)</script>Hello\u0000 World​ <b>bold</b>\u0007\n\n\n\n${"x".repeat(MAX_TRANSCRIPT_CHARS * 2)}`;
    const client = makeFakeClient(() => ({ text: dirty, hasReadableText: true }));
    const { text } = await transcribeImages({ images: [image()], client, model: "m" });

    expect(text.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_CHARS);
    expect(text).not.toMatch(/<[a-z/]/i);
    expect(text).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f​]/);
    expect(text).toContain("Hello World");
    expect(text).not.toMatch(/\n{3,}/);
  });

  it("throws short errors that the pipeline classifies like other LLM errors", async () => {
    const withStatus = makeFakeClient(() => {
      throw Object.assign(new Error("secret request details"), { status: 529 });
    });
    await expect(transcribeImages({ images: [image()], client: withStatus, model: "m" })).rejects.toThrow(
      "LLM request failed (status 529)."
    );

    const noStatus = makeFakeClient(() => {
      throw new Error("socket hang up");
    });
    const error = await transcribeImages({ images: [image()], client: noStatus, model: "m" }).catch((e) => e);
    expect(error.message).toBe("LLM request failed.");
    expect(error.message).not.toContain("socket");
  });

  it("reports a refusal and missing output, carrying usage", async () => {
    const refusal = { messages: { parse: async () => ({ stop_reason: "refusal", usage: { input_tokens: 7, output_tokens: 1 } }) } };
    const e1 = await transcribeImages({ images: [image()], client: refusal, model: "m" }).catch((e) => e);
    expect(e1.message).toBe("Model refused the request.");
    expect(e1.usage).toEqual({ input: 7, output: 1 });

    const empty = { messages: { parse: async () => ({ stop_reason: "max_tokens", usage: { input_tokens: 5, output_tokens: 9 } }) } };
    const e2 = await transcribeImages({ images: [image()], client: empty, model: "m" }).catch((e) => e);
    expect(e2.message).toContain("stop_reason=max_tokens");
    expect(e2.usage).toEqual({ input: 5, output: 9 });
  });

  it("needs a client and at least one image", async () => {
    await expect(transcribeImages({ images: [image()], model: "m" })).rejects.toThrow("No LLM client configured.");
    await expect(transcribeImages({ images: [], client: makeFakeClient(() => ({})), model: "m" })).rejects.toThrow(
      "No image to read."
    );
  });
});

describe("cleanTranscript", () => {
  it("returns '' for non-strings", () => {
    expect(cleanTranscript(undefined)).toBe("");
    expect(cleanTranscript(12)).toBe("");
  });

  it("keeps ordinary line breaks and trims trailing spaces", () => {
    expect(cleanTranscript("Line one   \r\nLine two\n\n\n\nLine three  ")).toBe("Line one\nLine two\n\nLine three");
  });
});

describe("buildCombinedText", () => {
  it("is the caption, a blank line, the marker line and the transcript", () => {
    expect(buildCombinedText("Hiring!", "Driver needed")).toBe(`Hiring!\n\n${IMAGE_TEXT_MARKER}\nDriver needed`);
    expect(IMAGE_TEXT_MARKER).toBe("[Text read from the attached image]");
  });

  it("has no leading blank lines for an empty caption, and is the caption alone without a transcript", () => {
    expect(buildCombinedText("", "Driver needed")).toBe(`${IMAGE_TEXT_MARKER}\nDriver needed`);
    expect(buildCombinedText("Hiring!", "")).toBe("Hiring!");
  });
});

describe("decision rule (imagesToRead)", () => {
  const urls = ["https://cdn1.telesco.pe/a.jpg", "https://cdn2.telesco.pe/b.jpg", "https://cdn3.telesco.pe/c.jpg"];
  const post = (overrides = {}) => ({ hasImage: true, imageUrls: urls, ...overrides });
  const on = (overrides = {}) => testConfig({ imagesEnabled: true, ...overrides });

  it("is off by default", () => {
    expect(imagesToRead(post(), "short", testConfig())).toEqual([]);
    expect(imagesToRead(post(), "short", {})).toEqual([]);
  });

  it("reads posts with a short caption and a photo", () => {
    expect(imagesToRead(post(), "", on())).toEqual(urls.slice(0, 2));
    expect(imagesToRead(post(), "x".repeat(399), on())).toHaveLength(2);
  });

  it("skips posts whose caption reaches the threshold", () => {
    expect(imagesToRead(post(), "x".repeat(400), on())).toEqual([]);
    expect(imagesToRead(post(), "x".repeat(450), on({ imageMinTextChars: 500 }))).toHaveLength(2);
  });

  it("needs hasImage and at least one allowed URL", () => {
    expect(imagesToRead(post({ hasImage: false }), "", on())).toEqual([]);
    expect(imagesToRead(post({ imageUrls: [] }), "", on())).toEqual([]);
    expect(imagesToRead({ hasImage: true }, "", on())).toEqual([]);
    expect(imagesToRead(post({ imageUrls: ["https://evil.example/a.jpg"] }), "", on())).toEqual([]);
  });

  it("honours the per-post limit, never above 3", () => {
    expect(imagesToRead(post(), "", on({ maxImagesPerPost: 1 }))).toHaveLength(1);
    expect(imagesToRead(post(), "", on({ maxImagesPerPost: 3 }))).toHaveLength(3);
    expect(imagesToRead(post({ imageUrls: [...urls, "https://cdn4.telesco.pe/d.jpg"] }), "", on({ maxImagesPerPost: 9 }))).toHaveLength(3);
  });
});

describe("image settings in getConfig (read at call time)", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const name of ["INGESTION_IMAGES_ENABLED", "INGESTION_IMAGE_MIN_TEXT_CHARS", "INGESTION_MAX_IMAGES_PER_POST"]) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it("defaults: off, 400 chars, 2 images", () => {
    delete process.env.INGESTION_IMAGES_ENABLED;
    delete process.env.INGESTION_IMAGE_MIN_TEXT_CHARS;
    delete process.env.INGESTION_MAX_IMAGES_PER_POST;
    expect(getConfig()).toMatchObject({ imagesEnabled: false, imageMinTextChars: 400, maxImagesPerPost: 2 });
  });

  it("is enabled only by the exact value 'true'", () => {
    for (const value of ["TRUE", "1", "yes", "True", " true", ""]) {
      process.env.INGESTION_IMAGES_ENABLED = value;
      expect(getConfig().imagesEnabled, value).toBe(false);
    }
    process.env.INGESTION_IMAGES_ENABLED = "true";
    expect(getConfig().imagesEnabled).toBe(true);
  });

  it("reads the numbers at call time, with a hard maximum of 3 images and fail-closed bad values", () => {
    process.env.INGESTION_IMAGE_MIN_TEXT_CHARS = "250";
    process.env.INGESTION_MAX_IMAGES_PER_POST = "3";
    expect(getConfig()).toMatchObject({ imageMinTextChars: 250, maxImagesPerPost: 3 });

    process.env.INGESTION_MAX_IMAGES_PER_POST = "10";
    expect(getConfig().maxImagesPerPost).toBe(3);

    process.env.INGESTION_IMAGE_MIN_TEXT_CHARS = "banana";
    expect(getConfig().imageMinTextChars).toBe(0);
  });
});

describe("image red flags", () => {
  const job = { title: "Accountant", company: "Acme Ltd", applyEmail: "hr@acme.example" };

  it("has the documented codes and messages", () => {
    expect(RED_FLAGS.FROM_IMAGE).toBe("from_image");
    expect(RED_FLAGS.CONTACT_FROM_IMAGE).toBe("contact_from_image");
    expect(RED_FLAG_MESSAGES.from_image).toBe("Read from an image. Check names, numbers and links against the picture.");
    expect(RED_FLAG_MESSAGES.contact_from_image).toBe("Contact details come from an image. Check them against the picture.");
  });

  it("adds nothing for posts without a transcript", () => {
    const flags = computeRedFlags({ job, text: "Acme hiring. hr@acme.example", linkClass: "none" });
    expect(flags).not.toContain("from_image");
    expect(flags).not.toContain("contact_from_image");
  });

  it("adds from_image when a transcript was used, and contact_from_image only when a contact is not in the caption", () => {
    const caption = "Acme Ltd is hiring, see the flyer.";
    const transcript = "Send CV to hr@acme.example";
    const text = buildCombinedText(caption, transcript);

    const fromPicture = computeRedFlags({ job, text, linkClass: "none", caption, transcript });
    expect(fromPicture).toContain("from_image");
    expect(fromPicture).toContain("contact_from_image");

    const captionWithEmail = "Acme Ltd is hiring. Email hr@acme.example";
    const inCaption = computeRedFlags({
      job,
      text: buildCombinedText(captionWithEmail, transcript),
      linkClass: "none",
      caption: captionWithEmail,
      transcript,
    });
    expect(inCaption).toContain("from_image");
    expect(inCaption).not.toContain("contact_from_image");
  });

  it("covers phones and links, with the caption's anchors counting as caption", () => {
    expect(contactsAbsentFrom({ applyPhone: "+2348012345678" }, "Call 0801 234 5678", [])).toEqual([]);
    expect(contactsAbsentFrom({ applyPhone: "+2348012345678" }, "no number here", [])).toEqual(["applyPhone"]);
    expect(contactsAbsentFrom({ applicationLink: "https://acme.example/jobs" }, "x", [{ href: "https://acme.example/jobs/" }])).toEqual([]);
    expect(contactsAbsentFrom({ applicationLink: "https://acme.example/jobs" }, "x", [])).toEqual(["applicationLink"]);
    expect(contactsAbsentFrom({ applyEmail: "HR@Acme.example" }, "mail hr@acme.example.", [])).toEqual([]);
  });

  it("does not flag contact_from_image when the job has no contact at all", () => {
    const flags = computeRedFlags({
      job: { title: "Driver", company: "Acme" },
      text: "x",
      linkClass: "none",
      caption: "x",
      transcript: "Driver wanted",
    });
    expect(flags).toContain("from_image");
    expect(flags).not.toContain("contact_from_image");
  });
});
