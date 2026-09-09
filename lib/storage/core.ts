import { AwsClient } from "aws4fetch"

/**
 * #7 pure storage-policy primitives: R2 object key construction, MIME
 * allowlisting, and presigned-URL signing. Nothing here touches a live
 * binding, so it's covered by `pnpm storage:contract` (no workerd
 * needed) rather than the Miniflare-backed Vitest suite that covers
 * `uploads.ts`/`downloads.ts`/`deletion.ts`/`provider-ingestion.ts`.
 */

const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]+$/
const SAFE_REPRESENTATION_PATTERN = /^[A-Za-z0-9_.-]+$/

/**
 * The D1 asset id is canonical, never a raw filename, provider URL, or
 * client-supplied key (#7). This is the only place an R2 object key is
 * constructed — callers never accept a key from the browser.
 */
export function buildAssetObjectKey(
  ownerId: string,
  assetId: string,
  representation: string
): string {
  if (!SAFE_ID_PATTERN.test(ownerId)) {
    throw new Error(`Unsafe owner id for R2 key construction: ${ownerId}`)
  }
  if (!SAFE_ID_PATTERN.test(assetId)) {
    throw new Error(`Unsafe asset id for R2 key construction: ${assetId}`)
  }
  if (!SAFE_REPRESENTATION_PATTERN.test(representation)) {
    throw new Error(`Unsafe representation name for R2 key construction: ${representation}`)
  }
  return `owners/${ownerId}/assets/${assetId}/${representation}`
}

export type ArtifactKind = "image" | "svg" | "audio" | "video" | "file" | "model3d"

/**
 * A model/provider returning an unexpected artifact type fails
 * ingestion rather than being rendered blindly (#7). Raster and SVG
 * are deliberately separate allowlists — never interchangeable
 * (matches #4's raster-vs-SVG doctrine).
 */
const MIME_ALLOWLIST: Record<ArtifactKind, readonly string[]> = {
  image: ["image/png", "image/jpeg", "image/webp", "image/gif"],
  svg: ["image/svg+xml"],
  audio: ["audio/mpeg", "audio/wav", "audio/webm", "audio/ogg", "audio/mp4"],
  video: ["video/mp4", "video/webm", "video/quicktime"],
  file: [
    "application/pdf",
    "text/plain",
    "text/markdown",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  model3d: ["model/gltf-binary", "model/gltf+json"],
}

export function isAllowedMime(artifactKind: ArtifactKind, mimeType: string): boolean {
  return MIME_ALLOWLIST[artifactKind]?.includes(mimeType) ?? false
}

export function assertAllowedMime(artifactKind: ArtifactKind, mimeType: string): void {
  if (!isAllowedMime(artifactKind, mimeType)) {
    throw new Error(
      `MIME type ${mimeType} is not allowed for artifact kind ${artifactKind}.`
    )
  }
}

/** Cloudflare recommends ordinary PUT under ~100 MB; larger uploads must use multipart (#7). */
export const SINGLE_PUT_MAX_BYTES = 100 * 1024 * 1024

/** R2 presigned URLs support 1 second to 7 days of expiry. */
const MIN_EXPIRY_SECONDS = 1
const MAX_EXPIRY_SECONDS = 7 * 24 * 60 * 60

export function clampExpirySeconds(requested: number): number {
  return Math.min(Math.max(Math.round(requested), MIN_EXPIRY_SECONDS), MAX_EXPIRY_SECONDS)
}

export interface R2SigningConfig {
  accountId: string
  bucketName: string
  accessKeyId: string
  secretAccessKey: string
}

export type PresignableMethod = "GET" | "PUT" | "HEAD" | "DELETE"

/**
 * Generates a presigned R2 (S3-compatible) URL restricted to one exact
 * key and operation (#7). Presigning is a pure local SigV4 computation
 * (via aws4fetch) — it never calls R2, so this is fully deterministic
 * and safe to unit test with fake credentials.
 */
export async function createPresignedUrl(
  config: R2SigningConfig,
  input: {
    method: PresignableMethod
    key: string
    expiresInSeconds: number
    contentType?: string
  }
): Promise<string> {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
    region: "auto",
  })

  const url = new URL(
    `https://${config.accountId}.r2.cloudflarestorage.com/${config.bucketName}/${input.key}`
  )
  url.searchParams.set("X-Amz-Expires", String(clampExpirySeconds(input.expiresInSeconds)))

  const headers: Record<string, string> = {}
  if (input.contentType) headers["content-type"] = input.contentType

  const signed = await client.sign(
    new Request(url, { method: input.method, headers }),
    // `allHeaders: true` is required to bind content-type into the
    // signature — aws4fetch excludes it by default (UNSIGNABLE_HEADERS),
    // which would let a PUT be completed with a different content-type
    // than the one this URL was authorized for.
    { aws: { signQuery: true, allHeaders: true } }
  )

  return signed.url
}
