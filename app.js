import express from "express";
const app = express();
import mongoose from "mongoose";
import "dotenv/config";

// import routes
import categoryRoutes from "./src/routes/category.routes.js";
import authRoutes from "./routes/auth.routes.js";

// db config
const mongoUri = process.env.MONGO_URI;
const port = process.env.PORT || 3000;

// middleware
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
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