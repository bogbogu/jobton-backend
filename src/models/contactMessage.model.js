import mongoose from "mongoose";
import {
  CONTACT_EMAIL_STATUSES,
  CONTACT_LIMITS,
  CONTACT_RETENTION_SECONDS,
} from "../utils/contact.utils.js";

// A copy of a message sent through the public contact form, so nothing is lost
// if the email fails. Deliberately NOT stored: the sender's IP address and user
// agent. Documents are deleted automatically after 90 days (TTL index on createdAt).
const ContactMessageSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: CONTACT_LIMITS.nameMax },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: CONTACT_LIMITS.emailMax },
    subject: { type: String, required: true, trim: true, maxlength: CONTACT_LIMITS.subjectMax },
    message: { type: String, required: true, trim: true, maxlength: CONTACT_LIMITS.messageMax },
    emailStatus: { type: String, enum: CONTACT_EMAIL_STATUSES, default: "failed" },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

ContactMessageSchema.index({ createdAt: 1 }, { expireAfterSeconds: CONTACT_RETENTION_SECONDS });

const ContactMessage = mongoose.model("ContactMessage", ContactMessageSchema);

export default ContactMessage;
