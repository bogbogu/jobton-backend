import User from "../models/user.model.js";
import bcrypt from "bcryptjs";
import generateToken from "../utils/generateToken.js";
import {
  sendVerificationEmail,
  sendResetPasswordEmail,
} from "../utils/email.service.js";
import {
  buildEmailVerificationData,
  buildPasswordResetData,
  EMAIL_VERIFICATION_EXPIRES_MINUTES,
  hashValue,
  isExpired,
  PASSWORD_RESET_EXPIRES_MINUTES,
  validatePasswordPolicy,
} from "../utils/authToken.utils.js";

const FORGOT_PASSWORD_RESPONSE_MESSAGE =
  "If that email exists, password reset instructions have been sent.";

export const registerUser = async (req, res) => {
    try {
    const { firstName, lastName, email, password } = req.body || {};

        if (!firstName || !lastName || !email || !password) {
            return res.status(400).json({
                message: "Please fill in all required fields.",
            });
        }

        const existingUser = await User.findOne({ email });

        if (existingUser) {
            return res.status(400).json({
                message: "Email already exists.",
            });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const verificationData = buildEmailVerificationData();

        const user = await User.create({
            firstName,
            lastName,
            email,
            password: hashedPassword,
          emailVerificationToken: verificationData.verificationTokenHash,
          emailVerificationCode: verificationData.verificationCodeHash,
          emailVerificationExpiresAt: verificationData.verificationExpiresAt,
        });

        let emailStatus = "sent";

        try {
          await sendVerificationEmail({
            toEmail: user.email,
            firstName: user.firstName,
            verificationToken: verificationData.verificationToken,
            verificationCode: verificationData.verificationCode,
            expiresInMinutes: EMAIL_VERIFICATION_EXPIRES_MINUTES,
          });
        } catch (emailError) {
          emailStatus = "failed";
          console.error("Verification email send failed:", emailError.message);
        }

        return res.status(201).json({
          message:
            emailStatus === "sent"
              ? "User registered successfully. Please verify your email."
              : "User registered successfully, but verification email could not be sent.",
          emailStatus,
            user: {
                id: user._id,
                firstName: user.firstName,
                lastName: user.lastName,
                email: user.email,
                role: user.role,
                isVerified: user.isVerified,
            },
        });

    } catch (error) {
      console.error(error);

        return res.status(500).json({
            message: "Internal server error.",
        });
    }
};


export const loginUser = async (req, res) => {
  try {
    const { email, password } = req.body || {};

    // Validate input
    if (!email || !password) {
      return res.status(400).json({
        message: "Please provide email and password.",
      });
    }

    // Find user
    const user = await User.findOne({ email }).select("+password");

    if (!user) {
      return res.status(401).json({
        message: "Invalid email or password.",
      });
    }

    // Compare password
    const isPasswordMatch = await bcrypt.compare(
      password,
      user.password
    );

    if (!isPasswordMatch) {
      return res.status(401).json({
        message: "Invalid email or password.",
      });
    }

    if (!user.isVerified) {
      return res.status(403).json({
        message: "Email not verified. Please verify your email before logging in.",
        error: "EMAIL_NOT_VERIFIED",
      });
    }

    // Generate token
    const token = generateToken(user._id);

    return res.status(200).json({
      message: "Login successful.",
      token,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role,
        isVerified: user.isVerified,
      },
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Internal server error.",
    });
  }
};

export const getCurrentUser = async (req, res) => {
  return res.status(200).json(req.user);
};

export const verifyEmail = async (req, res) => {
  try {
    const { token, email, code } = req.body || {};
    const hasToken = Boolean(token);
    const hasEmailAndCode = Boolean(email && code);

    if (!hasToken && !hasEmailAndCode) {
      return res.status(400).json({
        message: "Provide either verification token or email and verification code.",
      });
    }

    let user = null;

    if (hasToken) {
      user = await User.findOne({
        emailVerificationToken: hashValue(token),
      }).select("+emailVerificationToken +emailVerificationCode +emailVerificationExpiresAt");

      if (!user) {
        return res.status(400).json({
          message: "Invalid verification token.",
          error: "INVALID_TOKEN",
        });
      }
    } else {
      user = await User.findOne({
        email: String(email).toLowerCase().trim(),
      }).select("+emailVerificationToken +emailVerificationCode +emailVerificationExpiresAt");

      if (!user || user.emailVerificationCode !== hashValue(code)) {
        return res.status(400).json({
          message: "Invalid verification code.",
          error: "INVALID_CODE",
        });
      }
    }

    if (user.isVerified) {
      return res.status(409).json({
        message: "Email is already verified.",
        error: "ALREADY_VERIFIED",
      });
    }

    if (isExpired(user.emailVerificationExpiresAt)) {
      const expirationError = hasToken ? "EXPIRED_TOKEN" : "EXPIRED_CODE";

      return res.status(400).json({
        message: hasToken
          ? "Verification token has expired. Please request a new one."
          : "Verification code has expired. Please request a new one.",
        error: expirationError,
      });
    }

    user.isVerified = true;
    user.emailVerificationExpiresAt = new Date();
    await user.save();

    return res.status(200).json({
      message: "Email verified successfully.",
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Internal server error.",
    });
  }
};

export const resendVerificationEmail = async (req, res) => {
  try {
    const { email } = req.body || {};

    if (!email) {
      return res.status(400).json({
        message: "Email is required.",
      });
    }

    const user = await User.findOne({
      email: String(email).toLowerCase().trim(),
    }).select("+emailVerificationToken +emailVerificationCode +emailVerificationExpiresAt");

    if (!user || user.isVerified) {
      return res.status(200).json({
        message:
          "If that email exists and is not yet verified, a verification email has been sent.",
      });
    }

    const verificationData = buildEmailVerificationData();

    user.emailVerificationToken = verificationData.verificationTokenHash;
    user.emailVerificationCode = verificationData.verificationCodeHash;
    user.emailVerificationExpiresAt = verificationData.verificationExpiresAt;
    await user.save();

    try {
      await sendVerificationEmail({
        toEmail: user.email,
        firstName: user.firstName,
        verificationToken: verificationData.verificationToken,
        verificationCode: verificationData.verificationCode,
        expiresInMinutes: EMAIL_VERIFICATION_EXPIRES_MINUTES,
      });
    } catch (emailError) {
      console.error("Verification resend failed:", emailError.message);

      return res.status(500).json({
        message: "Could not send verification email. Please try again.",
      });
    }

    return res.status(200).json({
      message:
        "If that email exists and is not yet verified, a verification email has been sent.",
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Internal server error.",
    });
  }
};

export const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body || {};

    if (!email) {
      return res.status(400).json({
        message: "Email is required.",
      });
    }

    const normalizedEmail = String(email).toLowerCase().trim();

    const user = await User.findOne({ email: normalizedEmail }).select(
      "+passwordResetToken +passwordResetExpiresAt +passwordResetUsedAt"
    );

    if (!user) {
      return res.status(200).json({
        message: FORGOT_PASSWORD_RESPONSE_MESSAGE,
      });
    }

    const resetData = buildPasswordResetData();
    user.passwordResetToken = resetData.resetTokenHash;
    user.passwordResetExpiresAt = resetData.resetExpiresAt;
    user.passwordResetUsedAt = null;
    await user.save();

    try {
      await sendResetPasswordEmail({
        toEmail: user.email,
        firstName: user.firstName,
        resetToken: resetData.resetToken,
        expiresInMinutes: PASSWORD_RESET_EXPIRES_MINUTES,
      });
    } catch (emailError) {
      console.error("Password reset email send failed:", emailError.message);
    }

    return res.status(200).json({
      message: FORGOT_PASSWORD_RESPONSE_MESSAGE,
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Internal server error.",
    });
  }
};

export const resetPassword = async (req, res) => {
  try {
    const { token, password } = req.body || {};

    if (!token || !password) {
      return res.status(400).json({
        message: "Token and password are required.",
      });
    }

    const passwordValidation = validatePasswordPolicy(password);

    if (!passwordValidation.isValid) {
      return res.status(400).json({
        message: passwordValidation.message,
        error: "INVALID_PASSWORD",
      });
    }

    const user = await User.findOne({
      passwordResetToken: hashValue(token),
    }).select("+passwordResetToken +passwordResetExpiresAt +passwordResetUsedAt +password");

    if (!user) {
      return res.status(400).json({
        message: "Invalid reset token.",
        error: "INVALID_TOKEN",
      });
    }

    if (user.passwordResetUsedAt) {
      return res.status(400).json({
        message: "This reset token has already been used.",
        error: "USED_TOKEN",
      });
    }

    if (isExpired(user.passwordResetExpiresAt)) {
      return res.status(400).json({
        message: "Reset token has expired. Please request a new one.",
        error: "EXPIRED_TOKEN",
      });
    }

    user.password = await bcrypt.hash(password, 10);
    user.passwordResetUsedAt = new Date();
    user.passwordResetExpiresAt = new Date();
    await user.save();

    return res.status(200).json({
      message: "Password reset successful.",
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Internal server error.",
    });
  }
};