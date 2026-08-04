import { Resend } from "resend";
import validator from "validator";

const REQUIRED_EMAIL_ENV_VARS = [
  "RESEND_API_KEY",
  "RESEND_FROM_EMAIL",
  "RESEND_TO_EMAIL",
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
  const toEmail = getEnvValue("RESEND_TO_EMAIL");

  const parsedFromEmail = fromEmail.includes("<")
    ? fromEmail.match(/<([^>]+)>/)?.[1]?.trim() || ""
    : fromEmail;

  if (fromEmail && !validator.isEmail(parsedFromEmail)) {
    invalidVars.push("RESEND_FROM_EMAIL");
  }

  if (toEmail && !validator.isEmail(toEmail)) {
    invalidVars.push("RESEND_TO_EMAIL");
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
    fallbackToEmail: getEnvValue("RESEND_TO_EMAIL"),
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

export const sendWelcomeEmail = async ({ toEmail, firstName }) => {
  const { fromEmail, fallbackToEmail } = getEmailConfig();
  const resend = getResendClient();
  const recipient = toEmail || fallbackToEmail;
  const bcc = recipient !== fallbackToEmail ? [fallbackToEmail] : undefined;

  return resend.emails.send({
    from: fromEmail,
    to: [recipient],
    bcc,
    subject: "Welcome to Jobton",
    html: `<p>Hi ${firstName || "there"},</p><p>Your Jobton account is ready. Welcome aboard.</p>`,
  });
};
