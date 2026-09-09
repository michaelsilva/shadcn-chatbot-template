import { getCloudflareContext } from "@opennextjs/cloudflare"

import { getCurrentOwner } from "@/lib/current-owner"
import { deleteAsset } from "@/lib/storage/deletion"

/** Tombstones D1 before deleting the R2 object; idempotent across retries (#7). */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const { env } = await getCloudflareContext({ async: true })
  const owner = await getCurrentOwner(env)

  const result = await deleteAsset(env, { ownerId: owner.id, assetId: id })
  if (result === "not-found") {
    return Response.json({ error: "Asset not found." }, { status: 404 })
  }
  return Response.json({ outcome: result })
}
