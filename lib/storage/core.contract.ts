import {
  SINGLE_PUT_MAX_BYTES,
  assertAllowedMime,
  buildAssetObjectKey,
  clampExpirySeconds,
  createPresignedUrl,
  isAllowedMime,
  type R2SigningConfig,
} from "./core"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertThrows(fn: () => unknown, message: string) {
  try {
    fn()
  } catch {
    return
  }
  throw new Error(`${message}: expected error`)
}

const FAKE_SIGNING_CONFIG: R2SigningConfig = {
  accountId: "test-account",
  bucketName: "shadcn-chatbot-assets",
  accessKeyId: "AKIAFAKEKEYFORTESTS",
  secretAccessKey: "fake-secret-access-key-for-tests-only",
}

export async function runStorageCoreContractChecks() {
  assert(
    buildAssetObjectKey("owner_1", "asset_1", "original.png") ===
      "owners/owner_1/assets/asset_1/original.png",
    "asset object key uses the canonical owners/<owner>/assets/<asset>/<representation> shape"
  )

  assertThrows(
    () => buildAssetObjectKey("../etc", "asset_1", "original.png"),
    "path traversal in owner id is rejected"
  )
  assertThrows(
    () => buildAssetObjectKey("owner_1", "asset_1/../../secret", "original.png"),
    "path traversal in asset id is rejected"
  )
  assertThrows(
    () => buildAssetObjectKey("owner_1", "asset_1", "../../secret"),
    "path traversal in representation is rejected"
  )
  assertThrows(
    () => buildAssetObjectKey("owner_1", "asset_1", ""),
    "empty representation is rejected"
  )

  assert(isAllowedMime("image", "image/png"), "raster image mime is allowed for image kind")
  assert(!isAllowedMime("image", "image/svg+xml"), "svg mime is not allowed for image (raster) kind")
  assert(isAllowedMime("svg", "image/svg+xml"), "svg mime is allowed for svg kind")
  assert(!isAllowedMime("svg", "image/png"), "raster mime is not allowed for svg kind")
  assertThrows(
    () => assertAllowedMime("video", "application/x-msdownload"),
    "an unexpected/dangerous mime type is rejected for ingestion"
  )

  assert(SINGLE_PUT_MAX_BYTES === 100 * 1024 * 1024, "single-PUT ceiling matches documented policy")

  assert(clampExpirySeconds(0) === 1, "expiry below 1 second is clamped up to 1 second")
  assert(
    clampExpirySeconds(999_999_999) === 7 * 24 * 60 * 60,
    "expiry above 7 days is clamped down to 7 days"
  )
  assert(clampExpirySeconds(3600) === 3600, "an in-range expiry passes through unchanged")

  const putUrl = await createPresignedUrl(FAKE_SIGNING_CONFIG, {
    method: "PUT",
    key: "owners/owner_1/assets/asset_1/original.png",
    expiresInSeconds: 900,
    contentType: "image/png",
  })
  const parsedPut = new URL(putUrl)
  assert(
    parsedPut.pathname === "/shadcn-chatbot-assets/owners/owner_1/assets/asset_1/original.png",
    "presigned PUT URL targets exactly the requested bucket/key and nothing else"
  )
  assert(
    parsedPut.searchParams.get("X-Amz-Expires") === "900",
    "presigned URL expiry is carried through as the requested (clamped) value"
  )
  assert(
    (parsedPut.searchParams.get("X-Amz-SignedHeaders") ?? "").includes("content-type"),
    "content-type is bound into the PUT signature, so it can't be swapped after signing"
  )

  const getUrl = await createPresignedUrl(FAKE_SIGNING_CONFIG, {
    method: "GET",
    key: "owners/owner_1/assets/asset_1/original.png",
    expiresInSeconds: 300,
  })
  assert(
    new URL(getUrl).searchParams.get("X-Amz-Signature") !==
      parsedPut.searchParams.get("X-Amz-Signature"),
    "GET and PUT presigned URLs for the same key carry different signatures (method is bound into the signature)"
  )

  const otherKeyUrl = await createPresignedUrl(FAKE_SIGNING_CONFIG, {
    method: "PUT",
    key: "owners/owner_1/assets/asset_2/original.png",
    expiresInSeconds: 900,
    contentType: "image/png",
  })
  assert(
    new URL(otherKeyUrl).searchParams.get("X-Amz-Signature") !==
      parsedPut.searchParams.get("X-Amz-Signature"),
    "a presigned URL cannot be reused for a different key: signatures differ"
  )

  return true
}

void runStorageCoreContractChecks()
