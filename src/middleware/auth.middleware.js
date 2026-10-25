import jwt from "jsonwebtoken";
import User from "../models/user.model.js";
import { isAdminRole, isSuperAdminRole } from "../utils/roles.js";

// Pin the algorithm: never let the token's own header choose how it is verified.
const JWT_VERIFY_OPTIONS = { algorithms: ["HS256"] };

// A token issued before the user's last password reset is no longer valid.
// Token times are whole seconds, so compare at that precision.
const issuedBeforePasswordChange = (decoded, user) => {
  if (!user.passwordChangedAt) return false;
  const changedAt = Math.floor(new Date(user.passwordChangedAt).getTime() / 1000);
  return !Number.isFinite(decoded.iat) || decoded.iat < changedAt;
};

const protect = async (req, res, next) => {
  try {
    let token;

    // Check for Authorization header
    if (
      req.headers.authorization &&
      req.headers.authorization.startsWith("Bearer")
    ) {
      token = req.headers.authorization.split(" ")[1];

      // Verify token
      const decoded = jwt.verify(token, process.env.JWT_SECRET, JWT_VERIFY_OPTIONS);

      // Find user (password is excluded because of select: false)
      const user = await User.findById(decoded.id);

      if (!user) {
        return res.status(401).json({
          message: "Not authorized. User no longer exists.",
        });
      }

      if (issuedBeforePasswordChange(decoded, user)) {
        return res.status(401).json({
          message: "Not authorized. Please log in again.",
        });
      }

      req.user = user;

      return next();
    }

    return res.status(401).json({
      message: "Not authorized. No token provided.",
    });

  } catch (error) {
    console.error(error);

    return res.status(401).json({
      message: "Not authorized. Invalid token.",
    });
  }
};

// Like `protect`, but never rejects the request — used on public routes
// that need to know *if* the caller happens to be logged in (e.g. to mark
// which jobs they've saved) without requiring it. A missing or invalid
// token is silently treated as "anonymous," not an error.
export const optionalAuth = async (req, res, next) => {
  // The response can differ per caller (saved flags), so shared caches must key on the token.
  res.vary("Authorization");
  try {
    const header = req.headers.authorization;

    if (!header || !header.startsWith("Bearer")) {
      return next();
    }

    const token = header.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET, JWT_VERIFY_OPTIONS);
    const user = await User.findById(decoded.id);

    if (user && !issuedBeforePasswordChange(decoded, user)) {
      req.user = user;
    }

    return next();
  } catch (error) {
    return next();
  }
};

// Must run after `protect` (needs req.user). The role is read from the
// database on every request by `protect`, never from the JWT.
// Accepts "admin" and "superadmin".
export const requireAdmin = (req, res, next) => {
  if (!req.user || !isAdminRole(req.user.role)) {
    return res.status(403).json({ message: "Admin access required." });
  }

  return next();
};

// Must run after `protect`. Superadmin only (e.g. restoring a rejected or
// published job to review); a plain admin gets 403 FORBIDDEN_ROLE.
export const requireSuperAdmin = (req, res, next) => {
  if (!req.user || !isSuperAdminRole(req.user.role)) {
    return res.status(403).json({
      message: "Superadmin access required.",
      error: "FORBIDDEN_ROLE",
    });
  }

  return next();
};

export default protect;