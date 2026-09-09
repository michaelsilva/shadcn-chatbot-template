import { getCloudflareContext } from "@opennextjs/cloudflare"

import { getCurrentOwner } from "@/lib/current-owner"
import { finalizeUpload } from "@/lib/storage/uploads"

/** Verifies the R2 object exists before the asset becomes usable (#7). */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const { env } = await getCloudflareContext({ async: true })
  const owner = await getCurrentOwner(env)

  const result = await finalizeUpload(env, { ownerId: owner.id, assetId: id })
  if (result.outcome === "not-found-in-r2") {
    return Response.json(
      { error: "Upload not found in R2 yet. Finish the PUT and try again." },
      { status: 409 }
    )
  }
  return Response.json({ outcome: result.outcome, asset: result.asset })
}
