import express from "express";
const app = express();
import "dotenv/config";
import connectDB from "./src/config/db.js";
import cors from "cors";
import { fileURLToPath } from "url";


// import routes
import categoryRoutes from "./src/routes/category.routes.js";
import authRoutes from "./src/routes/auth.routes.js";
import { validateEmailConfig } from "./src/utils/email.service.js";

const port = process.env.PORT || 3000;

// middleware
app.use(cors({
    origin: true,
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