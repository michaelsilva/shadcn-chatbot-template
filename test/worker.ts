export default {
  async fetch() {
    return Response.json({ ok: true, worker: "shadcn-chatbot-db-test" })
  },
} satisfies ExportedHandler<unknown>
