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
import { validateEmailConfig } from "./src/utils/email.service.js";

const port = process.env.PORT || 3000;

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
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

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

app.get('/', (req, res) => {
    try {
        res.status(200).send('Hello from the API server')
        console.log('API is running')
    } catch (error) {
        res.status(500).json({ message: error.message })
    }
})

const currentFilePath = fileURLToPath(import.meta.url);

if (process.argv[1] === currentFilePath) {
    startServer();
}

export default app;