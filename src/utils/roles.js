// Single source of truth for role checks. "superadmin" can do everything an
// "admin" can, so every admin gate goes through isAdminRole; only the few
// superadmin-only actions (e.g. restoring a rejected job) use isSuperAdminRole.
//
// Nobody can become an admin or superadmin through the API: register and every
// other write path ignore a `role` in the request body. Roles are assigned
// directly in the database.

export const USER_ROLES = ["user", "admin", "superadmin"];

export const isAdminRole = (role) => role === "admin" || role === "superadmin";

export const isSuperAdminRole = (role) => role === "superadmin";
