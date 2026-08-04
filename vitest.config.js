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
        "src/utils/authToken.utils.js",
      ],
    },
  },
});
