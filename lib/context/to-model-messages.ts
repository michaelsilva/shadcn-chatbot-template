import type { ModelMessage } from "ai"
import type { PortableMessage } from "./types"

/**
 * The last translation step from #28's portable, provider-independent
 * context into the concrete AI SDK request shape #3's protocol
 * adapters consume. `PortableContentPart` is deliberately modeled on
 * the AI SDK's current (non-deprecated) `FilePart`, so this is a thin,
 * mechanical conversion rather than a second content model.
 */
export function toModelMessages(portable: readonly PortableMessage[]): ModelMessage[] {
  return portable.map((message) => ({
    role: message.role,
    content:
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) =>
            part.type === "text"
              ? { type: "text" as const, text: part.text }
              : { type: "file" as const, data: new URL(part.url), mediaType: part.mediaType }
          ),
  })) as ModelMessage[]
}
