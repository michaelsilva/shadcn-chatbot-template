import type { D1Migration } from "@cloudflare/vitest-plugin/config"

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    DB: D1Database
    TEST_MIGRATIONS: D1Migration[]
  }
}
