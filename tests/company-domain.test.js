import { describe, expect, it } from "vitest";
import { deriveCompanyDomain } from "../src/utils/companyDomain.js";
import { isValidDomain } from "../src/utils/validators.utils.js";

// The company defaults to "Acme" so a link on an acme host is vouched for by the name.
const fromLink = (applicationLink, company = "Acme") => deriveCompanyDomain({ applicationLink, company });
const fromEmail = (applyEmail) => deriveCompanyDomain({ applyEmail });

describe("deriveCompanyDomain", () => {
  it("returns the lowercase host of the apply link without www", () => {
    expect(fromLink("https://jobs.acme.com/careers/42?utm_source=tg")).toBe("jobs.acme.com");
    expect(fromLink("https://www.Acme.COM/apply")).toBe("acme.com");
    expect(fromLink("http://acme.com.ng")).toBe("acme.com.ng");
  });

  it("ignores ports, paths, query strings and a trailing dot", () => {
    expect(fromLink("https://acme.com:8443/apply#top")).toBe("acme.com");
    expect(fromLink("https://acme.com./apply")).toBe("acme.com");
  });

  it("falls back to the domain of the apply email", () => {
    expect(fromEmail("HR@Acme.com")).toBe("acme.com");
    expect(deriveCompanyDomain({ applicationLink: null, applyEmail: "careers@acme.co.uk" })).toBe("acme.co.uk");
  });

  it("prefers the apply link over the email when the company name vouches for the link", () => {
    expect(
      deriveCompanyDomain({ applicationLink: "https://acme.com/jobs", applyEmail: "hr@other.org", company: "Acme" })
    ).toBe("acme.com");
  });

  it("uses the email when the link points at a shared host", () => {
    expect(deriveCompanyDomain({ applicationLink: "https://bit.ly/abc", applyEmail: "hr@acme.com" })).toBe("acme.com");
    expect(deriveCompanyDomain({ applicationLink: "https://bit.ly/abc", applyEmail: "someone@gmail.com" })).toBeNull();
  });

  it.each([
    "https://t.me/somechannel/12",
    "https://telegram.me/x",
    "https://telegram.org/x",
    "https://wa.me/2348012345678",
    "https://chat.whatsapp.com/abc",
    "https://www.linkedin.com/jobs/view/1",
    "https://lnkd.in/abc",
    "https://ng.indeed.com/viewjob?jk=1",
    "https://www.jobberman.com/listings/x",
    "https://www.myjobmag.com/job/x",
    "https://www.glassdoor.com/job/x",
    "https://www.ziprecruiter.com/c/x",
    "https://forms.gle/abc",
    "https://docs.google.com/forms/d/e/abc/viewform",
    "https://www.google.com/url?q=x",
    "https://goo.gl/abc",
    "https://bit.ly/abc",
    "https://tinyurl.com/abc",
    "https://ow.ly/abc",
    "https://t.co/abc",
    "https://rebrand.ly/abc",
    "https://facebook.com/acme",
    "https://fb.me/abc",
    "https://www.instagram.com/p/abc",
    "https://twitter.com/acme",
    "https://x.com/acme",
    "https://www.tiktok.com/@acme",
    "https://www.youtube.com/watch?v=abc",
    "https://apply.workable.com/acme/j/ABC",
    "https://boards.greenhouse.io/acme/jobs/1",
    "https://jobs.lever.co/acme/1",
    "https://jobs.smartrecruiters.com/Acme/1",
    "https://jobs.ashbyhq.com/acme/1",
    "https://acme.breezy.hr/p/1",
    "https://acme.recruitee.com/o/x",
    "https://acme.bamboohr.com/careers/1",
    "https://jobs.jobvite.com/acme/job/1",
    "https://acme.wd1.myworkdayjobs.com/en-US/Careers",
    "https://acme.typeform.com/to/abc",
    "https://airtable.com/shr123",
    "https://www.notion.so/acme/job",
    "https://acme.notion.site/job",
    "https://linktr.ee/acme",
    "https://forms.office.com/r/abc",
    "https://www.microsoft.com/en-us/careers",
    "https://form.jotform.com/123",
    "https://tally.so/r/abc",
    "https://wellfound.com/company/acme/jobs",
  ])("returns null for the shared host in %s", (link) => {
    expect(fromLink(link)).toBeNull();
  });

  it.each([
    "gmail.com",
    "googlemail.com",
    "yahoo.com",
    "yahoo.co.uk",
    "ymail.com",
    "hotmail.com",
    "outlook.com",
    "live.com",
    "msn.com",
    "aol.com",
    "icloud.com",
    "proton.me",
    "protonmail.com",
    "mail.com",
    "gmx.com",
    "zoho.com",
  ])("returns null for the free-mail provider %s", (host) => {
    expect(fromEmail(`someone@${host}`)).toBeNull();
    expect(fromLink(`https://${host}/x`)).toBeNull();
  });

  it("blocks subdomains of a blocked host but not look-alike hosts", () => {
    expect(fromLink("https://deep.sub.workable.com/x")).toBeNull();
    expect(fromEmail("hr@mail.gmail.com")).toBeNull();
    // Only a real subdomain boundary counts.
    expect(fromLink("https://notworkable.com/x", "Notworkable")).toBe("notworkable.com");
    expect(fromLink("https://workable.com.acme.io/x")).toBe("workable.com.acme.io");
    expect(fromLink("https://acme-t.me.example.org/x", "Example")).toBe("acme-t.me.example.org");
  });

  describe("a link host must be vouched for", () => {
    it("gives null for a link whose host is not the company's and that the email does not confirm", () => {
      expect(deriveCompanyDomain({ applicationLink: "https://stripe.com/jobs/1", company: "Acme" })).toBeNull();
      expect(
        deriveCompanyDomain({ applicationLink: "https://stripe.com/jobs/1", applyEmail: "hr@acme.com", company: "Acme" })
      ).toBeNull();
      expect(deriveCompanyDomain({ applicationLink: "https://stripe.com/jobs/1" })).toBeNull();
      expect(deriveCompanyDomain({ applicationLink: "https://stripe.com/jobs/1", company: null })).toBeNull();
    });

    it("returns the link host when its main label is the company name", () => {
      expect(deriveCompanyDomain({ applicationLink: "https://stripe.com/jobs/1", company: "Stripe" })).toBe("stripe.com");
      expect(deriveCompanyDomain({ applicationLink: "https://careers.stripe.com/1", company: "Stripe Inc" })).toBe(
        "careers.stripe.com"
      );
      expect(deriveCompanyDomain({ applicationLink: "https://stripecareers.com/1", company: "Stripe" })).toBe("stripecareers.com");
    });

    it("does not accept a look-alike of the company name", () => {
      expect(deriveCompanyDomain({ applicationLink: "https://stripe-jobs.com/1", company: "Stripe" })).toBeNull();
      expect(deriveCompanyDomain({ applicationLink: "https://stripe.com.evil.io/1", company: "Stripe" })).toBeNull();
    });

    it("returns the link host when the apply email is on the same registrable domain", () => {
      expect(
        deriveCompanyDomain({ applicationLink: "https://careers.acme.com/1", applyEmail: "hr@acme.com", company: "Other" })
      ).toBe("careers.acme.com");
      expect(
        deriveCompanyDomain({ applicationLink: "https://acme.com/1", applyEmail: "hr@mail.acme.com", company: null })
      ).toBe("acme.com");
      expect(
        deriveCompanyDomain({ applicationLink: "https://jobs.acme.co.uk/1", applyEmail: "hr@acme.co.uk" })
      ).toBe("jobs.acme.co.uk");
    });

    it("does not treat a free-mail or blocked email as confirmation", () => {
      expect(
        deriveCompanyDomain({ applicationLink: "https://gmail.com/x", applyEmail: "hr@gmail.com", company: "Other" })
      ).toBeNull();
    });

    it("still allows an apply-email domain on its own", () => {
      expect(deriveCompanyDomain({ applyEmail: "hr@acme.com", company: "Whatever" })).toBe("acme.com");
      expect(deriveCompanyDomain({ applyEmail: "hr@acme.com" })).toBe("acme.com");
      expect(deriveCompanyDomain({ applyEmail: "hr@gmail.com", company: "Acme" })).toBeNull();
    });

    it("uses the email when the link is blocked or unusable", () => {
      expect(
        deriveCompanyDomain({ applicationLink: "https://t.me/x", applyEmail: "hr@acme.com", company: "Other" })
      ).toBe("acme.com");
      expect(deriveCompanyDomain({ applicationLink: "javascript:alert(1)", applyEmail: "hr@acme.com" })).toBe("acme.com");
    });
  });

  describe("hosting platforms, public suffixes and non-public names", () => {
    it.each([
      "https://acme.github.io/jobs",
      "https://acme.vercel.app/jobs",
      "https://acme.netlify.app/jobs",
      "https://acme.herokuapp.com/jobs",
      "https://acme.wixsite.com/jobs",
      "https://acme.wordpress.com/jobs",
      "https://acme.blogspot.com/jobs",
      "https://acme.weebly.com/jobs",
      "https://acme.webflow.io/jobs",
      "https://acme.pages.dev/jobs",
      "https://cutt.ly/abc",
      "https://rb.gy/abc",
      "https://shorturl.at/abc",
      "https://is.gd/abc",
      "https://wa.link/abc",
      "https://fb.com/acme",
    ])("returns null for %s even when the name matches", (link) => {
      expect(fromLink(link, "Acme")).toBeNull();
      expect(deriveCompanyDomain({ applicationLink: link, applyEmail: "hr@acme.com", company: "Acme" })).toBe("acme.com");
    });

    it.each(["co.uk", "com.ng", "org.ng", "gov.ng", "edu.ng"])("refuses the public suffix %s as a domain", (suffix) => {
      expect(deriveCompanyDomain({ applicationLink: `https://${suffix}/x`, company: "Co" })).toBeNull();
      expect(deriveCompanyDomain({ applyEmail: `hr@${suffix}` })).toBeNull();
    });

    it.each(["local", "internal", "test", "localhost", "example", "invalid"])("refuses hosts ending in .%s", (ending) => {
      expect(fromLink(`https://acme.${ending}/x`)).toBeNull();
      expect(fromLink(`https://jobs.acme.${ending}/x`)).toBeNull();
      expect(deriveCompanyDomain({ applyEmail: `hr@acme.${ending}` })).toBeNull();
    });

    it("still accepts real company hosts under a public suffix", () => {
      expect(deriveCompanyDomain({ applyEmail: "hr@acme.com.ng" })).toBe("acme.com.ng");
      expect(deriveCompanyDomain({ applyEmail: "hr@acme.org.ng" })).toBe("acme.org.ng");
    });
  });

  describe("hostile input", () => {
    it("never takes the host from userinfo", () => {
      expect(fromLink("https://acme.com@evil.example/apply")).toBeNull();
      expect(fromLink("https://user:pass@acme.com/apply")).toBeNull();
      expect(fromLink("https://t.me@acme.com/apply")).toBeNull();
    });

    it("rejects non-http schemes and malformed links", () => {
      for (const link of [
        "javascript:alert(1)",
        "JaVaScRiPt://acme.com/%0aalert(1)",
        "data:text/html,<script>x</script>",
        "ftp://acme.com/file",
        "mailto:hr@acme.com",
        "//acme.com/apply",
        "https:acme.com",
        "https://",
        "acme.com",
        "https://acme.com/a b",
        "https://acme​.com/apply",
        "",
        "   ",
      ]) {
        expect(fromLink(link), link).toBeNull();
      }
    });

    it("rejects IP and single-label hosts", () => {
      expect(fromLink("http://192.168.0.1/apply")).toBeNull();
      expect(fromLink("http://[::1]/apply")).toBeNull();
      expect(fromLink("http://localhost/apply")).toBeNull();
      expect(fromLink("http://intranet/apply")).toBeNull();
    });

    it("refuses internationalized (punycode) hosts", () => {
      expect(fromLink("https://аcme.com/apply")).toBeNull();
      expect(fromLink("https://xn--cme-9ve.com/apply")).toBeNull();
      expect(fromEmail("hr@xn--cme-9ve.com")).toBeNull();
    });

    it("rejects malformed emails", () => {
      for (const email of [
        "",
        "hr",
        "hr@",
        "@acme.com",
        "a@b@acme.com",
        "hr@acme",
        "hr@acme.com?bcc=x@evil.example",
        "hr@-acme.com",
        "hr@acme..com",
      ]) {
        expect(fromEmail(email), email).toBeNull();
      }
    });

    it("handles missing and non-string values", () => {
      expect(deriveCompanyDomain()).toBeNull();
      expect(deriveCompanyDomain({})).toBeNull();
      expect(deriveCompanyDomain({ applicationLink: null, applyEmail: null })).toBeNull();
      expect(deriveCompanyDomain({ applicationLink: 42, applyEmail: { toString: () => "a@acme.com" } })).toBeNull();
      expect(deriveCompanyDomain({ applicationLink: ["https://acme.com"], applyEmail: ["a@acme.com"] })).toBeNull();
    });

    it("stays fast on very long input", () => {
      const started = Date.now();
      expect(fromLink(`https://${"a".repeat(5000)}.com/x`)).toBeNull();
      expect(fromEmail(`${"a".repeat(5000)}@acme.com`)).toBeNull();
      expect(fromLink(`https://acme.com/${"/".repeat(100000)}`)).toBeNull();
      expect(Date.now() - started).toBeLessThan(1000);
    });
  });

  it("always returns a value the Job model's domain validator accepts", () => {
    for (const [link, company] of [
      ["https://acme.com", "Acme"],
      ["https://Jobs.Acme.com.ng:444/x", "Acme"],
      ["http://www.acme-corp.io/a?b=c", "Acme Corp"],
    ]) {
      const domain = fromLink(link, company);
      expect(domain).toBeTruthy();
      expect(isValidDomain(domain)).toBe(true);
      expect(domain).toBe(domain.toLowerCase());
      expect(domain.startsWith("www.")).toBe(false);
    }
  });
});
