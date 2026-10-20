import express from "express";
import swaggerUi from "swagger-ui-express";
import openapiSpec from "../docs/openapi.js";

// Interactive API documentation. app.js mounts this ONLY when
// API_DOCS_ENABLED === "true"; when the flag is off none of these routes exist
// and /api-docs falls through to the normal 404.
//
// Helmet's Content-Security-Policy is deliberately left untouched here:
// swagger-ui-express serves its bootstrap as a separate file
// (/api-docs/swagger-ui-init.js), so the default `script-src 'self'` allows it.
const router = express.Router();

router.get("/api-docs.json", (req, res) => res.status(200).json(openapiSpec));

router.use(
  "/api-docs",
  swaggerUi.serve,
  swaggerUi.setup(openapiSpec, { customSiteTitle: "Jobton API docs" })
);

export default router;
