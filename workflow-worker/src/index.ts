export { RuntimeProbeWorkflow } from "./runtime-probe-workflow"

export default {
  async fetch() {
    return Response.json({ ok: true, worker: "shadcn-chatbot-workflows" })
  },
} satisfies ExportedHandler<unknown>
