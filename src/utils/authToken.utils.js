import crypto from "crypto";

export const EMAIL_VERIFICATION_EXPIRES_MINUTES = 20;
export const PASSWORD_RESET_EXPIRES_MINUTES = 20;

export const hashValue = (value) => {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
};

export const buildEmailVerificationData = (
  expiresInMinutes = EMAIL_VERIFICATION_EXPIRES_MINUTES
) => {
  const verificationToken = crypto.randomBytes(32).toString("hex");
  const verificationCode = crypto.randomInt(100000, 1000000).toString();
  const verificationExpiresAt = new Date(
    Date.now() + expiresInMinutes * 60 * 1000
  );

  return {
    verificationToken,
    verificationCode,
    verificationTokenHash: hashValue(verificationToken),
    verificationCodeHash: hashValue(verificationCode),
    verificationExpiresAt,
  };
};

export const buildPasswordResetData = (
  expiresInMinutes = PASSWORD_RESET_EXPIRES_MINUTES
) => {
  const resetToken = crypto.randomBytes(32).toString("hex");
  const resetExpiresAt = new Date(Date.now() + expiresInMinutes * 60 * 1000);

  return {
    resetToken,
    resetTokenHash: hashValue(resetToken),
    resetExpiresAt,
  };
};

export const isExpired = (dateValue) => {
  if (!dateValue) {
    return true;
  }

  return new Date(dateValue).getTime() < Date.now();
};

export const validatePasswordPolicy = (password) => {
  if (!password || String(password).length < 8) {
    return {
      isValid: false,
      message: "Password must be at least 8 characters long.",
    };
  }

  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return {
      isValid: false,
      message: "Password must contain at least one letter and one number.",
    };
  }

  return {
    isValid: true,
    message: "Password is valid.",
  };
};
