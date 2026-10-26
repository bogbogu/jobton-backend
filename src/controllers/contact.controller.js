import ContactMessage from "../models/contactMessage.model.js";
import { sendContactMessageEmail, validateEmailConfig } from "../utils/email.service.js";
import {
  CONTACT_GLOBAL_PER_HOUR,
  CONTACT_GLOBAL_WINDOW_MS,
  isHoneypotFilled,
  validateContactInput,
} from "../utils/contact.utils.js";
import {
  allowContactEmail,
  contactRateLimitedResponse,
} from "../middleware/contactRateLimit.middleware.js";

const RECEIVED_BODY = { message: "Message received." };

// True when this many messages (from anyone) were already saved in the last hour.
// If the count cannot be read, assume the cap is reached: skipping an email is the safe side.
const globalCapReached = async () => {
  try {
    const recent = await ContactMessage.countDocuments({
      createdAt: { $gte: new Date(Date.now() - CONTACT_GLOBAL_WINDOW_MS) },
    });

    return recent >= CONTACT_GLOBAL_PER_HOUR;
  } catch {
    return true;
  }
};

export const submitContactMessage = async (req, res) => {
  try {
    // The hidden field a person never fills in. A bot gets the normal answer and
    // nothing is saved or sent, so it cannot tell it was caught.
    if (isHoneypotFilled(req.body)) {
      return res.status(201).json(RECEIVED_BODY);
    }

    const result = validateContactInput(req.body);

    if (!result.ok) {
      if (result.reason === "INVALID_INPUT") {
        return res.status(400).json({
          message: "Invalid request payload.",
          error: "INVALID_INPUT",
        });
      }

      const details = Object.values(result.fields).join(" ");

      return res.status(400).json({
        message: `Validation failed. ${details}`,
        error: "VALIDATION_ERROR",
        fields: result.fields,
      });
    }

    const { name, email, subject, message } = result.value;

    if (!allowContactEmail(email)) {
      return contactRateLimitedResponse(res);
    }

    // Counted before saving, so the new message is not part of its own count.
    const capReached = await globalCapReached();

    // Save first: the message is kept even if the email cannot be sent.
    const saved = await ContactMessage.create({ name, email, subject, message, emailStatus: "failed" });

    let emailStatus = "failed";

    if (capReached) {
      // Flood protection: keep the message, spend no email quota. Ids only, no content.
      emailStatus = "skipped";
      console.warn(`Contact email cap reached (${CONTACT_GLOBAL_PER_HOUR}/hour): email skipped for message ${saved._id}.`);
    } else if (!validateEmailConfig().isValid) {
      emailStatus = "skipped";
    } else {
      try {
        await sendContactMessageEmail({ name, email, subject, message });
        emailStatus = "sent";
      } catch {
        // Ids only: never the visitor's text or address.
        console.error(`Contact email failed for message ${saved._id}.`);
      }
    }

    if (emailStatus !== "failed") {
      try {
        await ContactMessage.updateOne({ _id: saved._id }, { $set: { emailStatus } });
      } catch {
        console.error(`Could not update emailStatus for contact message ${saved._id}.`);
      }
    }

    return res.status(201).json(RECEIVED_BODY);
  } catch (error) {
    // Name and code only: a raw error can carry driver text or submitted values.
    console.error(`Contact request failed: ${error?.name || "Error"}${error?.code ? ` (${error.code})` : ""}`);

    return res.status(500).json({ message: "Internal server error." });
  }
};
