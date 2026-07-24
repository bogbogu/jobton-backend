import express from "express";
const app = express();
import "dotenv/config";
import connectDB from "./src/config/db.js";
import cors from "cors";


// import routes
import categoryRoutes from "./src/routes/category.routes.js";
import authRoutes from "./src/routes/auth.routes.js";

const port = process.env.PORT || 3000;

// middleware
app.use(cors({
    origin: true,
    credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
connectDB().then(() => {
    app.listen(port, () => {
        console.log(`Server is running on port ${port}`);
    });
});

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