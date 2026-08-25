import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.js"],
    setupFiles: ["tests/setup.js"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: [
        "src/controllers/auth.controller.js",
        "src/controllers/job.controller.js",
        "src/controllers/freelancer.controller.js",
        "src/controllers/category.controller.js",
        "src/utils/authToken.utils.js",
        "src/utils/format.utils.js",
      ],
    },
  },
});
