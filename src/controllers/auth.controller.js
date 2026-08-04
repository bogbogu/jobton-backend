import User from "../models/user.model.js";
import bcrypt from "bcryptjs";
import generateToken from "../utils/generateToken.js";
import { sendWelcomeEmail } from "../utils/email.service.js";

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

        const user = await User.create({
            firstName,
            lastName,
            email,
            password: hashedPassword,
        });

        const token = generateToken(user._id);

        let emailStatus = "sent";

        try {
          await sendWelcomeEmail({
            toEmail: user.email,
            firstName: user.firstName,
          });
        } catch (emailError) {
          emailStatus = "failed";
          console.error("Welcome email send failed:", emailError.message);
        }

        return res.status(201).json({
          message:
            emailStatus === "sent"
              ? "User registered successfully."
              : "User registered successfully, but welcome email could not be sent.",
            token,
          emailStatus,
            user: {
                id: user._id,
                firstName: user.firstName,
                lastName: user.lastName,
                email: user.email,
                role: user.role,
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