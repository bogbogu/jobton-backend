import { beforeEach, describe, expect, it, vi } from "vitest";

// Fake Resend client. The REAL SDK resolves with { data, error } and does not
// throw when its API rejects a message, which is the behavior under test.
const send = vi.fn();
vi.mock("resend", () => ({
  Resend: class {
    emails = { send };
  },
}));

process.env.RESEND_API_KEY = "re_test_not_a_real_key";
process.env.RESEND_FROM_EMAIL = "Jobton <noreply@example.com>";
process.env.RESEND_TO_EMAIL = "audit@example.com";
process.env.FRONTEND_URL = "https://app.example.com";

const { sendVerificationEmail, sendResetPasswordEmail, validateEmailConfig } = await import("../src/utils/email.service.js");

const verificationArgs = {
  toEmail: "new.user@example.com",
  firstName: "Ada",
  verificationToken: "tok",
  verificationCode: "123456",
  expiresInMinutes: 15,
};

describe("email.service sends", () => {
  beforeEach(() => send.mockReset());

  it("returns the provider data when Resend accepts the message", async () => {
    send.mockResolvedValueOnce({ data: { id: "email_123" }, error: null });

    await expect(sendVerificationEmail(verificationArgs)).resolves.toEqual({ id: "email_123" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({
      from: "Jobton <noreply@example.com>",
      to: ["new.user@example.com"],
    });
    // Credential-bearing mail goes to the recipient only.
    expect(send.mock.calls[0][0]).not.toHaveProperty("bcc");
    expect(send.mock.calls[0][0]).not.toHaveProperty("cc");
    expect(JSON.stringify(send.mock.calls[0][0].to)).not.toContain("audit@example.com");
  });

  it("does not BCC the password reset email either", async () => {
    send.mockResolvedValueOnce({ data: { id: "email_456" }, error: null });

    await sendResetPasswordEmail({ toEmail: "a@example.com", firstName: "A", resetToken: "t", expiresInMinutes: 15 });

    expect(send.mock.calls[0][0].to).toEqual(["a@example.com"]);
    expect(send.mock.calls[0][0]).not.toHaveProperty("bcc");
  });

  it("refuses to send without a valid recipient instead of falling back to a default mailbox", async () => {
    await expect(sendVerificationEmail({ ...verificationArgs, toEmail: undefined })).rejects.toThrow(
      "A valid recipient email address is required."
    );
    await expect(
      sendResetPasswordEmail({ toEmail: "", firstName: "A", resetToken: "t", expiresInMinutes: 15 })
    ).rejects.toThrow("A valid recipient email address is required.");
    expect(send).not.toHaveBeenCalled();
  });

  it("no longer requires RESEND_TO_EMAIL", () => {
    const previous = process.env.RESEND_TO_EMAIL;
    delete process.env.RESEND_TO_EMAIL;

    try {
      expect(validateEmailConfig()).toEqual({ isValid: true, missingVars: [], invalidVars: [] });
    } finally {
      process.env.RESEND_TO_EMAIL = previous;
    }
  });

  it("throws with Resend's reason when the verification email is rejected", async () => {
    send.mockResolvedValueOnce({
      data: null,
      error: { name: "validation_error", statusCode: 403, message: "The example.com domain is not verified." },
    });

    await expect(sendVerificationEmail(verificationArgs)).rejects.toThrow(
      "Resend rejected the email (validation_error 403): The example.com domain is not verified."
    );
  });

  it("throws when the password reset email is rejected", async () => {
    send.mockResolvedValueOnce({
      data: null,
      error: { name: "invalid_api_key", statusCode: 401, message: "API key is invalid." },
    });

    await expect(
      sendResetPasswordEmail({ toEmail: "a@example.com", firstName: "A", resetToken: "t", expiresInMinutes: 15 })
    ).rejects.toThrow("Resend rejected the email (invalid_api_key 401): API key is invalid.");
  });

  it("does not put the API key in the error message", async () => {
    send.mockResolvedValueOnce({ data: null, error: { name: "x", statusCode: 500, message: "boom" } });

    const error = await sendVerificationEmail(verificationArgs).catch((e) => e);
    expect(String(error.message)).not.toContain("re_test_not_a_real_key");
  });
});

describe("email.service HTML safety", () => {
  beforeEach(() => send.mockReset());

  it("escapes the first name in both credential emails", async () => {
    const payload = '<a href="https://evil.example">Click</a>';
    send.mockResolvedValue({ data: { id: "x" }, error: null });

    await sendVerificationEmail({ ...verificationArgs, firstName: payload });
    await sendResetPasswordEmail({ toEmail: "a@example.com", firstName: payload, resetToken: "t", expiresInMinutes: 15 });

    for (const call of send.mock.calls) {
      expect(call[0].html).not.toContain("<a href=\"https://evil.example\">");
      expect(call[0].html).toContain("&lt;a href=");
    }
  });
});
