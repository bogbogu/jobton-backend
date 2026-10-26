import express from "express";
const app = express();
import "dotenv/config";
import connectDB from "./src/config/db.js";
import cors from "cors";
import helmet from "helmet";
import { fileURLToPath } from "url";


// import routes
import categoryRoutes from "./src/routes/category.routes.js";
import authRoutes from "./src/routes/auth.routes.js";
import jobRoutes from "./src/routes/job.route.js";
import freelancerRoutes from "./src/routes/freelancer.routes.js";
import companyRoutes from "./src/routes/company.routes.js";
import newsletterRoutes from "./src/routes/newsletter.routes.js";
import contactRoutes from "./src/routes/contact.routes.js";
import adminRoutes from "./src/routes/admin.routes.js";
import docsRoutes from "./src/routes/docs.routes.js";
import noStore from "./src/middleware/cacheControl.middleware.js";
import { notFoundHandler, errorHandler } from "./src/middleware/error.middleware.js";
import { validateEmailConfig } from "./src/utils/email.service.js";
import { configureTrustProxy } from "./src/utils/trustProxy.js";

const port = process.env.PORT || 3000;

// Request bodies here are small JSON documents (the largest field is a 10,000
// character job description). Anything bigger is rejected with 413.
const BODY_LIMIT = "100kb";

// Allow-list of trusted frontend origins. CORS_ALLOWED_ORIGINS supports a
// comma-separated list (e.g. local dev + deployed frontend); if it's unset,
// fall back to FRONTEND_URL alone. These are deliberately separate env
// vars: FRONTEND_URL is also used by email.service.js to build a single
// verification/reset link and must stay one plain URL — it can't double as
// a comma-separated CORS list without breaking that validation. Trailing
// slashes are stripped here too — an Origin header never has one, so a
// value like "https://example.com/" would otherwise never match.
const allowedOrigins = String(process.env.CORS_ALLOWED_ORIGINS || process.env.FRONTEND_URL || "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);

// Do not advertise the framework. (Helmet also removes this header; the explicit
// call keeps it off even if helmet is reconfigured or removed.)
app.disable("x-powered-by");
configureTrustProxy(app);

// middleware
app.use(helmet());
app.use(cors({
    origin: (origin, callback) => {
        // No Origin header (e.g. same-origin requests, curl, Supertest) —
        // not a cross-origin browser request, so nothing to restrict here.
        if (!origin || allowedOrigins.includes(origin)) {
            return callback(null, true);
        }

        // Fail closed without throwing: the cors middleware simply omits
        // the CORS headers, so the browser blocks the response client-side
        // instead of an uncaught error leaking a stack trace to the client.
        return callback(null, false);
    },
    credentials: true,
}));
app.use(express.json({ limit: BODY_LIMIT }));
app.use(express.urlencoded({ extended: false, limit: BODY_LIMIT }));

// Account, session and contact data: never cached by browsers or proxies.
app.use(["/api/auth", "/api/freelancers", "/api/admin", "/api/contact"], noStore);

const emailConfigValidation = validateEmailConfig();

if (!emailConfigValidation.isValid) {
    const validationIssues = [
        ...emailConfigValidation.missingVars,
        ...emailConfigValidation.invalidVars,
    ];

    console.warn(
        `Email service is disabled. Check environment variables: ${validationIssues.join(", ")}`
    );
}

export const startServer = async () => {
    // Checked here, not at import time, so tests and tooling can import the app
    // without a secret. Without it every token would be signed with "undefined".
    if (!process.env.JWT_SECRET || !process.env.JWT_SECRET.trim()) {
        throw new Error("JWT_SECRET is not set. Refusing to start.");
    }

    if (process.env.JWT_SECRET.length < 32) {
        console.warn("JWT_SECRET is shorter than 32 characters. Rotate it to a long random value.");
    }

    await connectDB();

    app.listen(port, () => {
        console.log(`Server is running on port ${port}`);
    });
};

// routes
app.use("/api/categories", categoryRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/jobs", jobRoutes);
app.use("/api/freelancers", freelancerRoutes);
app.use("/api/companies", companyRoutes);
app.use("/api/newsletter", newsletterRoutes);
app.use("/api/contact", contactRoutes);
app.use("/api/admin", adminRoutes);

// Swagger UI (/api-docs) and the raw spec (/api-docs.json). Off unless explicitly
// enabled: the docs list every endpoint, so they are not exposed by default.
// Read once at start-up; when disabled the routes are never registered.
if (process.env.API_DOCS_ENABLED === "true") {
    app.use(docsRoutes);
}

// Liveness check.
app.get("/", (req, res) => res.status(200).json({ message: "API is running." }));

// Must stay last: unmatched routes, then every error from the middleware above.
app.use(notFoundHandler);
app.use(errorHandler);

const currentFilePath = fileURLToPath(import.meta.url);

if (process.argv[1] === currentFilePath) {
    startServer().catch((error) => {
        console.error("Failed to start server:", error.message);
        process.exit(1);
    });
}

export default app;