import { describe, expect, it } from "vitest";
import {
  buildEmailVerificationData,
  buildPasswordResetData,
  hashValue,
  isExpired,
  validatePasswordPolicy,
} from "../src/utils/authToken.utils.js";

describe("authToken utils", () => {
  it("hashValue should be deterministic", () => {
    expect(hashValue("abc")).toBe(hashValue("abc"));
    expect(hashValue("abc")).not.toBe(hashValue("abcd"));
  });

  it("buildEmailVerificationData should create token, 6-digit code, and future expiry", () => {
    const data = buildEmailVerificationData(20);

    expect(data.verificationToken).toHaveLength(64);
    expect(data.verificationCode).toMatch(/^\d{6}$/);
    expect(data.verificationTokenHash).toBe(hashValue(data.verificationToken));
    expect(data.verificationCodeHash).toBe(hashValue(data.verificationCode));
    expect(data.verificationExpiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("buildPasswordResetData should create token and future expiry", () => {
    const data = buildPasswordResetData(20);

    expect(data.resetToken).toHaveLength(64);
    expect(data.resetTokenHash).toBe(hashValue(data.resetToken));
    expect(data.resetExpiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("isExpired should return true for null and past dates", () => {
    expect(isExpired(null)).toBe(true);
    expect(isExpired(new Date(Date.now() - 10_000))).toBe(true);
  });

  it("isExpired should return false for future dates", () => {
    expect(isExpired(new Date(Date.now() + 10_000))).toBe(false);
  });

  it("validatePasswordPolicy should enforce minimum strength", () => {
    expect(validatePasswordPolicy("short1").isValid).toBe(false);
    expect(validatePasswordPolicy("onlyletters").isValid).toBe(false);
    expect(validatePasswordPolicy("12345678").isValid).toBe(false);
    expect(validatePasswordPolicy("Strong123").isValid).toBe(true);
  });
});
