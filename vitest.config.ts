import { defineConfig } from "vitest/config";

// Tests run against the Firestore + Auth emulators (real Firestore semantics),
// started by `npm test` through `firebase emulators:exec`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
    // All files share the same emulator data, which each test wipes.
    fileParallelism: false,
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "html"],
    },
  },
});
