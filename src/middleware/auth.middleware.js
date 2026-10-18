import jwt from "jsonwebtoken";
import User from "../models/user.model.js";

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
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // Find user (password is excluded because of select: false)
      const user = await User.findById(decoded.id);

      if (!user) {
        return res.status(401).json({
          message: "Not authorized. User no longer exists.",
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
  try {
    const header = req.headers.authorization;

    if (!header || !header.startsWith("Bearer")) {
      return next();
    }

    const token = header.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);

    if (user) {
      req.user = user;
    }

    return next();
  } catch (error) {
    return next();
  }
};

// Must run after `protect` (needs req.user). The role is read from the
// database on every request by `protect`, never from the JWT.
export const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ message: "Admin access required." });
  }

  return next();
};

export default protect;