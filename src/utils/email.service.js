import { Resend } from "resend";
import validator from "validator";

const REQUIRED_EMAIL_ENV_VARS = [
  "RESEND_API_KEY",
  "RESEND_FROM_EMAIL",
  "RESEND_TO_EMAIL",
  "FRONTEND_URL",
];

let resendClient;

const getEnvValue = (name) => {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
};

const getMissingEmailEnvVars = () => {
  return REQUIRED_EMAIL_ENV_VARS.filter((name) => !getEnvValue(name));
};

const getInvalidEmailEnvVars = () => {
  const invalidVars = [];
  const fromEmail = getEnvValue("RESEND_FROM_EMAIL");
  const defaultToEmail = getEnvValue("RESEND_TO_EMAIL");
  const frontendUrl = getEnvValue("FRONTEND_URL");

  const parsedFromEmail = fromEmail.includes("<")
    ? fromEmail.match(/<([^>]+)>/)?.[1]?.trim() || ""
    : fromEmail;

  if (fromEmail && !validator.isEmail(parsedFromEmail)) {
    invalidVars.push("RESEND_FROM_EMAIL");
  }

  if (defaultToEmail && !validator.isEmail(defaultToEmail)) {
    invalidVars.push("RESEND_TO_EMAIL");
  }

  if (
    frontendUrl &&
    !validator.isURL(frontendUrl, {
      require_protocol: true,
      require_tld: false,
    })
  ) {
    invalidVars.push("FRONTEND_URL");
  }

  return invalidVars;
};

const getEmailConfig = () => {
  const missingVars = getMissingEmailEnvVars();
  const invalidVars = getInvalidEmailEnvVars();

  if (missingVars.length > 0) {
    throw new Error(
      `Missing required email environment variables: ${missingVars.join(", ")}`
    );
  }

  if (invalidVars.length > 0) {
    throw new Error(
      `Invalid email environment variables: ${invalidVars.join(", ")}`
    );
  }

  return {
    apiKey: getEnvValue("RESEND_API_KEY"),
    fromEmail: getEnvValue("RESEND_FROM_EMAIL"),
    defaultToEmail: getEnvValue("RESEND_TO_EMAIL"),
    frontendUrl: getEnvValue("FRONTEND_URL"),
  };
};

const getResendClient = () => {
  if (!resendClient) {
    const { apiKey } = getEmailConfig();
    resendClient = new Resend(apiKey);
  }

  return resendClient;
};

export const validateEmailConfig = () => {
  const missingVars = getMissingEmailEnvVars();
  const invalidVars = getInvalidEmailEnvVars();

  return {
    isValid: missingVars.length === 0 && invalidVars.length === 0,
    missingVars,
    invalidVars,
  };
};

export const sendVerificationEmail = async ({
  toEmail,
  firstName,
  verificationToken,
  verificationCode,
  expiresInMinutes,
}) => {
  const { fromEmail, defaultToEmail, frontendUrl } = getEmailConfig();
  const resend = getResendClient();
  const verificationLink = `${frontendUrl.replace(/\/$/, "")}/verify-email?token=${encodeURIComponent(verificationToken)}`;
  const recipient = toEmail || defaultToEmail;
  const bcc = recipient !== defaultToEmail ? [defaultToEmail] : undefined;

  return resend.emails.send({
    from: fromEmail,
    to: [recipient],
    bcc,
    subject: "Verify your Jobton email address",
    html: `<div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1f2937;">
  <h2 style="margin-bottom: 12px;">Welcome to Jobton!</h2>
  <p>Hi ${firstName || "there"},</p>
  <p>
    Welcome to <strong>Jobton</strong>. We are excited to have you join our growing community.
  </p>
  <p>
    Our mission is simple: to connect talented professionals with trusted opportunities through a platform built on transparency, verification, and meaningful career growth.
  </p>
  <p>
    To get started, please verify your email address using the button below or enter the verification code provided in this email. This helps us keep Jobton secure and ensures your account is protected.
  </p>
  <p style="margin: 24px 0;">
    <a href="${verificationLink}" style="display: inline-block; padding: 12px 18px; background-color: #0f766e; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600;">Verify Email</a>
  </p>
  <p>
    Verification code: <strong style="font-size: 18px; letter-spacing: 2px;">${verificationCode}</strong>
  </p>
  <p>
    This code expires in ${expiresInMinutes} minutes.
  </p>
  <p>
    Once verified, you will be able to complete your profile and begin exploring opportunities on Jobton.
  </p>
  <p>
    We are glad you are here, and we look forward to being part of your career journey.
  </p>
  <p>
    The Jobton Team
  </p>
</div>`,
  });
};

export const sendResetPasswordEmail = async ({
  toEmail,
  firstName,
  resetToken,
  expiresInMinutes,
}) => {
  const { fromEmail, defaultToEmail, frontendUrl } = getEmailConfig();
  const resend = getResendClient();
  const resetLink = `${frontendUrl.replace(/\/$/, "")}/reset-password?token=${encodeURIComponent(resetToken)}`;
  const recipient = toEmail || defaultToEmail;
  const bcc = recipient !== defaultToEmail ? [defaultToEmail] : undefined;

  return resend.emails.send({
    from: fromEmail,
    to: [recipient],
    bcc,
    subject: "Reset your Jobton password",
    html: `<div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1f2937;">
  <h2 style="margin-bottom: 12px;">Password Reset Request</h2>
  <p>Hi ${firstName || "there"},</p>
  <p>
    We received a request to reset your Jobton password.
  </p>
  <p style="margin: 24px 0;">
    <a href="${resetLink}" style="display: inline-block; padding: 12px 18px; background-color: #0f766e; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600;">Reset Password</a>
  </p>
  <p>
    This link expires in ${expiresInMinutes} minutes.
  </p>
  <p>
    If you did not request this reset, you can safely ignore this email.
  </p>
  <p>
    The Jobton Team
  </p>
</div>`,
  });
};
