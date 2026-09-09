import path from "node:path"
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrationsPath = path.join(import.meta.dirname, "..", "migrations")
      const migrations = await readD1Migrations(migrationsPath)
      return {
        // Not ../wrangler.jsonc: that config declares an `ai` binding,
        // and simply declaring one (regardless of `remote: true`) makes
        // Miniflare try to open a remote proxy session at pool startup
        // — which needs a real CLOUDFLARE_API_TOKEN in CI. See
        // test/wrangler.jsonc's own comment.
        wrangler: { configPath: "./test/wrangler.jsonc" },
        miniflare: {
          // Test-only binding so the setup file can apply migrations
          // against the local D1 simulation before each test file runs.
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
})
