import { getCloudflareContext } from "@opennextjs/cloudflare"
import { z } from "zod"

import { getCurrentOwner } from "@/lib/current-owner"
import { requireStorageEnv } from "@/lib/storage/env"
import { createUploadIntent } from "@/lib/storage/uploads"

const ArtifactKindSchema = z.enum(["image", "svg", "audio", "video", "file", "model3d"])

const RequestSchema = z.object({
  artifactKind: ArtifactKindSchema,
  mimeType: z.string().min(1),
  byteSize: z.number().int().positive(),
  representation: z.string().min(1).optional(),
})

/**
 * #7's authenticated short-lived presigned-PUT flow. The browser
 * uploads directly to R2 with the returned URL — this route never sees
 * the file bytes.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null)
  const parsed = RequestSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json({ error: "Invalid upload-intent request." }, { status: 400 })
  }

  const { env } = await getCloudflareContext({ async: true })
  const owner = await getCurrentOwner(env)

  try {
    const intent = await createUploadIntent(requireStorageEnv(env), {
      ownerId: owner.id,
      bucketName: env.ASSETS_BUCKET_NAME,
      artifactKind: parsed.data.artifactKind,
      mimeType: parsed.data.mimeType,
      byteSize: parsed.data.byteSize,
      representation: parsed.data.representation,
    })
    return Response.json({
      assetId: intent.asset.id,
      uploadUrl: intent.uploadUrl,
      expiresInSeconds: intent.expiresInSeconds,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not create upload intent."
    return Response.json({ error: message }, { status: 400 })
  }
}
