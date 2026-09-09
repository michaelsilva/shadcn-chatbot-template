import type { LedgerEnv } from "../db/env"
import type { R2SigningConfig } from "./core"

/** Functions that only read/write/delete R2 objects via the binding — no presigning. */
export interface AssetBucketEnv extends LedgerEnv {
  ASSETS_BUCKET: R2Bucket
}

/**
 * Functions that mint presigned URLs additionally need the R2
 * S3-compatible API credentials. These are Worker secrets
 * (`wrangler secret put ...`), never committed and never sent to the
 * browser — see docs/r2-asset-storage.md.
 */
export interface StorageEnv extends AssetBucketEnv {
  CLOUDFLARE_ACCOUNT_ID: string
  R2_ACCESS_KEY_ID: string
  R2_SECRET_ACCESS_KEY: string
}

/** Loosely-typed shape of the generated `CloudflareEnv`: secrets are `string | undefined` until configured. */
export interface UnconfiguredStorageEnv extends AssetBucketEnv {
  CLOUDFLARE_ACCOUNT_ID?: string
  R2_ACCESS_KEY_ID?: string
  R2_SECRET_ACCESS_KEY?: string
}

/**
 * Narrows an app `env` into a `StorageEnv`, throwing a clear
 * configuration error (matching `atomic-executor.ts`'s
 * `requireEnvString` pattern) rather than letting a missing R2 API
 * token surface as an obscure signing failure. Only needed by
 * functions that actually presign a URL (`createUploadIntent`,
 * `createDownloadUrl`) — everything else only needs `AssetBucketEnv`.
 */
export function requireStorageEnv(env: UnconfiguredStorageEnv): StorageEnv {
  const missing = (["CLOUDFLARE_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] as const).filter(
    (key) => !env[key]?.trim()
  )
  if (missing.length > 0) {
    throw new Error(
      `Missing R2 storage configuration: ${missing.join(", ")}. Set these as Worker secrets (see docs/r2-asset-storage.md).`
    )
  }
  return env as StorageEnv
}

export function signingConfig(env: StorageEnv, bucketName: string): R2SigningConfig {
  return {
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    bucketName,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  }
}
