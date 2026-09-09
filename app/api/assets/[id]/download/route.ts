import { getCloudflareContext } from "@opennextjs/cloudflare"

import { getCurrentOwner } from "@/lib/current-owner"
import { createDownloadUrl } from "@/lib/storage/downloads"
import { requireStorageEnv } from "@/lib/storage/env"

/** Mints a short-lived presigned GET for a private, owner-authorized asset (#7). */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const { env } = await getCloudflareContext({ async: true })
  const owner = await getCurrentOwner(env)

  const result = await createDownloadUrl(requireStorageEnv(env), {
    ownerId: owner.id,
    assetId: id,
    bucketName: env.ASSETS_BUCKET_NAME,
  })

  if (result.outcome === "not-found") {
    return Response.json({ error: "Asset not found." }, { status: 404 })
  }
  if (result.outcome === "not-usable") {
    return Response.json({ error: "Asset is not ready for download yet." }, { status: 409 })
  }
  return Response.json({ url: result.url, expiresInSeconds: result.expiresInSeconds })
}
