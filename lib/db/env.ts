/**
 * Shared binding shape for the repository layer. Both the OpenNext app
 * Worker and the sibling Workflow Worker bind the same D1 database (#25),
 * so this module works unmodified from either script's env.
 */
export interface LedgerEnv {
  DB: D1Database
}
