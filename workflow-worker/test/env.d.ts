import type { D1Migration } from "@cloudflare/vitest-plugin/config"

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    DB: D1Database
    ASSETS_BUCKET: R2Bucket
    RUNTIME_PROBE_WORKFLOW: Workflow
    PLAN_EXECUTION_WORKFLOW: Workflow
    TEST_MIGRATIONS: D1Migration[]
  }
}
