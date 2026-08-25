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
import { validateEmailConfig } from "./src/utils/email.service.js";

const port = process.env.PORT || 3000;

// Allow-list of trusted frontend origins, built from FRONTEND_URL (supports
// a comma-separated list, e.g. local dev + deployed frontend).
const allowedOrigins = String(process.env.FRONTEND_URL || "")
    .split(",")
    .map((origin) => origin.trim())
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