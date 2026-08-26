import validator from "validator";
import NewsletterSubscriber from "../models/newsletterSubscriber.model.js";

export const subscribeNewsletter = async (req, res) => {
  try {
    const { email } = req.body || {};

    if (!email || !validator.isEmail(String(email))) {
      return res.status(400).json({
        message: "Please provide a valid email address.",
      });
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    const existing = await NewsletterSubscriber.findOne({ email: normalizedEmail });

    if (existing) {
      return res.status(200).json({
        message: "You're already subscribed to the newsletter.",
      });
    }

    await NewsletterSubscriber.create({ email: normalizedEmail });

    return res.status(201).json({
      message: "Subscribed successfully.",
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Failed to subscribe. Please try again.",
    });
  }
};
