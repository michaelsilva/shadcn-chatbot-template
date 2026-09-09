import { getCloudflareContext } from "@opennextjs/cloudflare"

import { RuntimeProbeParamsSchema } from "@/lib/runtime-probe"

/**
 * #25 infrastructure proof: shows the OpenNext app Worker creating and
 * inspecting Workflow instances defined in the sibling `shadcn-chatbot-workflows`
 * Worker script. Not a product endpoint — #24 owns real workflow triggers.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const params = RuntimeProbeParamsSchema.parse(body)

  const { env } = await getCloudflareContext({ async: true })
  const instance = await env.RUNTIME_PROBE_WORKFLOW.create({ params })

  return Response.json({ id: instance.id, status: await instance.status() })
}

export async function GET(req: Request) {
  const instanceId = new URL(req.url).searchParams.get("instanceId")
  if (!instanceId) {
    return Response.json({ error: "instanceId is required" }, { status: 400 })
  }

  const { env } = await getCloudflareContext({ async: true })
  const instance = await env.RUNTIME_PROBE_WORKFLOW.get(instanceId)

  return Response.json({ id: instance.id, status: await instance.status() })
}
