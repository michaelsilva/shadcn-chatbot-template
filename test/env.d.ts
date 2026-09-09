import type { D1Migration } from "@cloudflare/vitest-plugin/config"

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    DB: D1Database
    ASSETS_BUCKET: R2Bucket
    CLOUDFLARE_ACCOUNT_ID: string
    R2_ACCESS_KEY_ID: string
    R2_SECRET_ACCESS_KEY: string
    TEST_MIGRATIONS: D1Migration[]
  }
}
