import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.js"],
    setupFiles: ["tests/setup.js"],
    // Every test file starts its own in-memory mongod; under parallel load the
    // default 10s hook timeout is not enough.
    hookTimeout: 60000,
    testTimeout: 30000,
    // Each test file starts its own in-memory MongoDB. Starting 20+ at once overloads
    // an ordinary machine and makes suites time out at start-up, so cap the parallelism.
    maxWorkers: 4,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: [
        "app.js",
        "src/controllers/auth.controller.js",
        "src/controllers/job.controller.js",
        "src/controllers/freelancer.controller.js",
        "src/controllers/category.controller.js",
        "src/controllers/company.controller.js",
        "src/controllers/newsletter.controller.js",
        "src/utils/authToken.utils.js",
        "src/utils/format.utils.js",
        "src/utils/slugify.utils.js",
      ],
    },
  },
});
