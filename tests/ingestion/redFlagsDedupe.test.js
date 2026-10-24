import { describe, expect, it } from "vitest";
import { computeDedupeKey, hashPostText } from "../../src/services/ingestion/dedupe.js";
import { RED_FLAGS, computeRedFlags } from "../../src/services/ingestion/redFlags.js";

const goodJob = {
  title: "Accountant",
  company: "Acme Nigeria Ltd",
  applyEmail: "careers@acme.com",
};

describe("computeRedFlags", () => {
  it("returns nothing for a clean post", () => {
    expect(
      computeRedFlags({ job: goodJob, text: "Acme is hiring. Email careers@acme.com", linkClass: "none" })
    ).toEqual([]);
  });

  it("flags fee wording", () => {
    for (const text of [
      "Pay a registration fee of N5000 to start",
      "A refundable deposit is required",
      "Send money for your starter kit",
      "You must buy a form at our office",
      "Pay N2,000 to book your slot",
      "Training fee applies",
    ]) {
      expect(computeRedFlags({ job: goodJob, text, linkClass: "none" })).toContain(RED_FLAGS.FEE);
    }
  });

  it("does not flag explicit 'no fee' statements", () => {
    expect(
      computeRedFlags({ job: goodJob, text: "There is no registration fee. Application is free of charge.", linkClass: "none" })
    ).not.toContain(RED_FLAGS.FEE);
  });

  it("flags requests for sensitive data", () => {
    for (const text of ["Send your BVN and bank details", "Provide your account number", "attach your passport photograph", "NIN required"]) {
      expect(computeRedFlags({ job: goodJob, text, linkClass: "none" })).toContain(RED_FLAGS.SENSITIVE_DATA);
    }
  });

  it("flags WhatsApp-only contact", () => {
    const flags = computeRedFlags({
      job: { title: "Rep", company: "Acme", applyPhone: "+2348012345678" },
      text: "Chat us on WhatsApp 08012345678 to apply",
      linkClass: "none",
    });
    expect(flags).toContain(RED_FLAGS.MESSAGING_ONLY);

    const waLink = computeRedFlags({
      job: { title: "Rep", company: "Acme", applicationLink: "https://wa.me/2348012345678" },
      text: "Apply: https://wa.me/2348012345678",
      linkClass: "social_or_short",
    });
    expect(waLink).toEqual(expect.arrayContaining([RED_FLAGS.MESSAGING_ONLY, RED_FLAGS.MESSAGING_OR_SHORT_LINK]));
  });

  it("does not flag messaging when an email is also given", () => {
    const flags = computeRedFlags({
      job: { ...goodJob, applyPhone: "+2348012345678" },
      text: "Email careers@acme.com or WhatsApp 08012345678",
      linkClass: "none",
    });
    expect(flags).not.toContain(RED_FLAGS.MESSAGING_ONLY);
  });

  it("flags form links", () => {
    const flags = computeRedFlags({
      job: { ...goodJob, applicationLink: "https://forms.gle/abc" },
      text: "Apply via https://forms.gle/abc",
      linkClass: "form",
    });
    expect(flags).toContain(RED_FLAGS.FORM_LINK);
  });

  it("flags a missing employer and a missing apply method", () => {
    const flags = computeRedFlags({ job: { title: "Driver" }, text: "Driver needed in Lagos", linkClass: "none" });
    expect(flags).toEqual([RED_FLAGS.NO_EMPLOYER, RED_FLAGS.NO_APPLY_METHOD]);
  });

  it("flags punycode hosts", () => {
    const link = "https://xn--pple-43d.com/jobs";
    const flags = computeRedFlags({ job: { ...goodJob, applicationLink: link }, text: `Apply ${link}`, linkClass: "other_domain" });
    expect(flags).toContain(RED_FLAGS.PUNYCODE);
    expect(
      computeRedFlags({ job: goodJob, text: "See https://xn--80ak6aa92e.com/x", linkClass: "none" })
    ).toContain(RED_FLAGS.PUNYCODE);
  });

  it("flags a free-mail address for a named company", () => {
    expect(
      computeRedFlags({ job: { ...goodJob, applyEmail: "acme.hr@gmail.com" }, text: "mail acme.hr@gmail.com", linkClass: "none" })
    ).toContain(RED_FLAGS.FREE_MAIL);
    expect(
      computeRedFlags({ job: { title: "x", applyEmail: "someone@gmail.com" }, text: "someone@gmail.com", linkClass: "none" })
    ).not.toContain(RED_FLAGS.FREE_MAIL);
  });
});

describe("dedupe", () => {
  it("hashPostText ignores case, punctuation, emoji and spacing", () => {
    expect(hashPostText("We're HIRING!!  Accountant \n Lagos")).toBe(hashPostText("we re hiring 📢 accountant lagos"));
    expect(hashPostText("a")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPostText("one")).not.toBe(hashPostText("two"));
  });

  it("computeDedupeKey is stable across formatting differences", () => {
    const a = computeDedupeKey({ title: "Sales Rep.", company: "Acme Ltd", location: "Lagos", description: "x" });
    const b = computeDedupeKey({ title: "  sales   rep ", company: "ACME LTD!", location: "lagos", description: "totally different" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs when title, company or location differ", () => {
    const base = { title: "Sales Rep", company: "Acme", location: "Lagos" };
    const key = computeDedupeKey(base);
    expect(computeDedupeKey({ ...base, title: "Sales Manager" })).not.toBe(key);
    expect(computeDedupeKey({ ...base, company: "Beta" })).not.toBe(key);
    expect(computeDedupeKey({ ...base, location: "Abuja" })).not.toBe(key);
  });

  it("mixes in the start of the description only when the company is missing", () => {
    const base = { title: "Driver", location: "Lagos" };
    const a = computeDedupeKey({ ...base, description: "Drive trucks across Nigeria" });
    const b = computeDedupeKey({ ...base, description: "Deliver parcels on a bike" });
    expect(a).not.toBe(b);
    expect(computeDedupeKey({ ...base, description: "Drive trucks across Nigeria" })).toBe(a);

    const withCompany = { ...base, company: "Acme" };
    expect(computeDedupeKey({ ...withCompany, description: "one" })).toBe(computeDedupeKey({ ...withCompany, description: "two" }));
  });
});
