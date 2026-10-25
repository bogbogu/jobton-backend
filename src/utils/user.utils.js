// The ONLY shape in which a user is ever sent to a client. An allow-list, so a
// field added to the User schema later (tokens, expiry dates, flags, __v,
// timestamps) is not exposed unless it is added here on purpose.
export const serializeUser = (user) => ({
  id: user._id.toString(),
  name: `${user.firstName} ${user.lastName}`.trim(),
  firstName: user.firstName,
  lastName: user.lastName,
  email: user.email,
  role: user.role,
  isVerified: user.isVerified,
});
