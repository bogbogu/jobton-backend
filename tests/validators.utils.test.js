import { describe, expect, it } from "vitest";
import {
  classifyLink,
  cleanText,
  isSafeHttpUrl,
  isValidEmail,
} from "../src/utils/validators.utils.js";

const timed = (fn) => {
  const start = performance.now();
  const result = fn();
  return { result, ms: performance.now() - start };
};

import { normalizePhone as normalizePhoneStrict } from "../src/utils/validators.utils.js";

describe("cleanText", () => {
  it("strips tags and control/invisible characters", () => {
    expect(cleanText("<b>Senior</b> Accountant\u200b\u202e")).toBe("Senior Accountant");
    expect(cleanText("  a\u0000b \u2066c  ")).toBe("ab c");
    expect(cleanText("x < y and y > z")).toBe("x < y and y > z");
    expect(cleanText(42)).toBe(42);
  });

  it("cleans pathological tag input in linear time (ReDoS regression)", () => {
    for (const input of ["<a".repeat(48000), "<a ".repeat(30000), `<a${" ".repeat(60000)}`, "<!".repeat(40000)]) {
      const { ms } = timed(() => cleanText(input));
      expect(ms).toBeLessThan(100);
    }
  });

  it("caps its input so oversize values still exceed every field's maxlength afterwards", () => {
    const cleaned = cleanText("x".repeat(100000));
    expect(cleaned.length).toBe(20000);
    expect(cleaned.length).toBeGreaterThan(10000);
  });
});

describe("isSafeHttpUrl", () => {
  it("accepts normal URLs, including percent-encoding and unicode letters in paths", () => {
    expect(isSafeHttpUrl("https://acme.com/careers/42?a=b%20c")).toBe(true);
    expect(isSafeHttpUrl("http://jobs.acme.co.uk/role")).toBe(true);
    expect(isSafeHttpUrl("https://acme.com/jobs/ingénieur-données")).toBe(true);
    expect(isSafeHttpUrl("https://acme.com/%E2%9C%93")).toBe(true);
  });

  it("rejects https:evil.com (no slashes) and other non-http forms", () => {
    for (const bad of [
      "https:evil.com",
      "http:evil.com/x",
      "https:/evil.com",
      "//evil.com",
      "javascript:alert(1)",
      "data:text/html,x",
      "ftp://files.acme.com/a",
      "https://user:pw@acme.com/",
      "https://localhost/",
      "https://127.0.0.1/",
    ]) {
      expect(isSafeHttpUrl(bad), bad).toBe(false);
    }
  });

  it("rejects invisible, bidi and exotic whitespace characters anywhere in the URL", () => {
    const chars = [
      "\u00a0", "\u2028", "\u2029", "\u3000", "\u2060", "\u2064", "\u206f", "\u061c",
      "\u00ad", "\u180e", "\ufff9", "\ufffa", "\ufffb", "\u200b", "\u202e", "\u2066", "\ufeff", " ", "\t", "\u0007", "\u0085",
    ];
    for (const char of chars) {
      const code = char.charCodeAt(0).toString(16);
      expect(isSafeHttpUrl(`https://acme.com/a${char}b`), `path U+${code}`).toBe(false);
      expect(isSafeHttpUrl(`https://acme${char}.com/`), `host U+${code}`).toBe(false);
    }
  });
});

describe("isValidEmail", () => {
  it("accepts plain ASCII addresses", () => {
    for (const ok of ["hr@acme.com", "first.last+tag@sub.acme.co.uk", "a_b%c@acme-corp.ng", "HR@Acme.com"]) {
      expect(isValidEmail(ok), ok).toBe(true);
    }
  });

  it("rejects mailto parameter smuggling, quoted locals, bidi/format characters, IP and UTF-8 forms", () => {
    for (const bad of [
      "a?bcc=evil@x.com",
      "a&subject=x@y.com",
      '"a b"@x.com',
      "a\u202e@x.com",
      "a\u200b@x.com",
      "a@x\u200b.com",
      "a@x.com\u2066",
      "ünï@x.com",
      "a@[127.0.0.1]",
      "a@127.0.0.1",
      "a@localhost",
      "a@x.c",
      "a@x.123",
      "a@-x.com",
      "a@x..com",
      "a b@x.com",
      "a@b@x.com",
      "@x.com",
      "",
      42,
    ]) {
      expect(isValidEmail(bad), String(bad)).toBe(false);
    }
  });
});

describe("classifyLink", () => {
  it("treats the company's own registrable domain as company_domain", () => {
    expect(classifyLink("https://acme.com/jobs/1", "Acme")).toBe("company_domain");
    expect(classifyLink("https://careers.acme.com/jobs/1", "Acme")).toBe("company_domain");
    expect(classifyLink("https://hris.churchgate.com/apply", "Churchgate Group")).toBe("company_domain");
    expect(classifyLink("https://acme.co.uk/jobs", "Acme Ltd")).toBe("company_domain");
    expect(classifyLink("https://www.acme.com.ng/jobs", "Acme Nigeria Limited")).toBe("company_domain");
    expect(classifyLink("https://acmecareers.com/", "Acme")).toBe("company_domain");
    expect(classifyLink("https://acmejobs.com/", "Acme")).toBe("company_domain");
    expect(classifyLink("https://my-company.com/", "My Company")).toBe("company_domain");
  });

  it("does not treat look-alike domains as company_domain", () => {
    expect(classifyLink("https://acme.com.evil.com/apply", "Acme")).toBe("other_domain");
    expect(classifyLink("https://acme-jobs.xyz/apply", "Acme")).toBe("other_domain");
    expect(classifyLink("https://notacme.com/apply", "Acme")).toBe("other_domain");
    expect(classifyLink("https://acme.evil.co.uk/apply", "Acme")).toBe("other_domain");
    expect(classifyLink("https://evil.com/acme", "Acme")).toBe("other_domain");
    expect(classifyLink("https://co.uk/", "Acme")).toBe("other_domain");
  });

  it("detects forms by host and path, never by a substring anywhere in the URL", () => {
    expect(classifyLink("https://docs.google.com/forms/d/e/abc/viewform", "Acme")).toBe("form");
    expect(classifyLink("https://forms.gle/abc", "Acme")).toBe("form");
    expect(classifyLink("https://acme.typeform.com/to/x", "Acme")).toBe("form");
    expect(classifyLink("https://form.jotform.com/123", "Acme")).toBe("form");
    expect(classifyLink("https://tally.so/r/x", "Acme")).toBe("form");
    expect(classifyLink("https://forms.office.com/r/x", "Acme")).toBe("form");

    expect(classifyLink("https://evil.com/?u=docs.google.com/forms", "Acme")).toBe("other_domain");
    expect(classifyLink("https://evil.com/typeform.com", "Acme")).toBe("other_domain");
    expect(classifyLink("https://evil.com/#forms.gle", "Acme")).toBe("other_domain");
    expect(classifyLink("https://nottypeform.com/x", "Acme")).toBe("other_domain");
    expect(classifyLink("https://docs.google.com/document/d/abc", "Acme")).toBe("other_domain");
  });

  it("keeps ATS, social and none classifications", () => {
    expect(classifyLink("https://boards.greenhouse.io/acme/jobs/1", "Acme")).toBe("ats");
    expect(classifyLink("https://wa.me/2348012345678", "Acme")).toBe("social_or_short");
    expect(classifyLink("https://bit.ly/x", "Acme")).toBe("social_or_short");
    expect(classifyLink(undefined, "Acme")).toBe("none");
    expect(classifyLink("https:evil.com", "Acme")).toBe("none");
  });
});

describe("normalizePhone is strict about what it accepts", () => {
  it("normalizes ordinary Nigerian and international formats", () => {
    expect(normalizePhoneStrict("08012345678")).toBe("+2348012345678");
    expect(normalizePhoneStrict("(0801) 234-5678")).toBe("+2348012345678");
    expect(normalizePhoneStrict("+234 801 234 5678")).toBe("+2348012345678");
    expect(normalizePhoneStrict("2348012345678")).toBe("+2348012345678");
  });

  it("rejects letters and symbols instead of deleting them and gluing digits together", () => {
    expect(normalizePhoneStrict("+234 801 234 5678 ext 12")).toBeNull();
    expect(normalizePhoneStrict("8012345;ext=1")).toBeNull();
    expect(normalizePhoneStrict("Call 0801 234 5678 or 0902 345 6789")).toBeNull();
    expect(normalizePhoneStrict("tel:+2348012345678")).toBeNull();
  });

  it("rejects two numbers on separate lines rather than merging them", () => {
    expect(normalizePhoneStrict("1234567" + String.fromCharCode(10) + "7654321")).toBeNull();
    expect(normalizePhoneStrict("1234567" + String.fromCharCode(13, 10) + "7654321")).toBeNull();
  });

  it("rejects too short, too long and non-string values", () => {
    expect(normalizePhoneStrict("12")).toBeNull();
    expect(normalizePhoneStrict("1".repeat(16))).toBeNull();
    expect(normalizePhoneStrict("1".repeat(60))).toBeNull();
    expect(normalizePhoneStrict(null)).toBeNull();
    expect(normalizePhoneStrict(8012345678)).toBeNull();
  });
});
