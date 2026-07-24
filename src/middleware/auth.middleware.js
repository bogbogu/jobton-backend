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
      req.user = await User.findById(decoded.id);

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

export default protect;