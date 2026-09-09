import {
  assertNever,
  type ConversationMessage,
  type ConversationPart,
} from "@/lib/conversation"

function AssetLabel({
  kind,
  assetId,
  detail,
}: {
  kind: string
  assetId: string
  detail?: string
}) {
  return (
    <div className="rounded-lg border bg-muted/30 px-3 py-2 text-sm">
      <div className="font-medium">{kind}</div>
      <div className="text-muted-foreground">{detail ?? assetId}</div>
    </div>
  )
}

export function ConversationPartView({ part }: { part: ConversationPart }) {
  switch (part.type) {
    case "text":
      return <div className="whitespace-pre-wrap">{part.text}</div>

    case "image":
      return (
        <AssetLabel
          kind={part.representation === "svg" ? "SVG image" : "Raster image"}
          assetId={part.asset.assetId}
          detail={part.alt ?? part.asset.fileName ?? part.asset.assetId}
        />
      )

    case "audio":
      return (
        <AssetLabel
          kind={`Audio · ${part.role}`}
          assetId={part.asset.assetId}
          detail={part.asset.fileName ?? part.asset.format ?? part.asset.assetId}
        />
      )

    case "transcript":
      return (
        <div className="rounded-lg border px-3 py-2 text-sm">
          <div className="mb-1 font-medium">
            Transcript{part.language ? ` · ${part.language}` : ""}
          </div>
          <div className="whitespace-pre-wrap text-muted-foreground">
            {part.text}
          </div>
        </div>
      )

    case "video":
      return (
        <AssetLabel
          kind={`Video · ${part.role}`}
          assetId={part.asset.assetId}
          detail={part.asset.fileName ?? part.asset.format ?? part.asset.assetId}
        />
      )

    case "model3d":
      return (
        <AssetLabel
          kind={`3D asset · ${part.role}`}
          assetId={part.asset.assetId}
          detail={part.asset.fileName ?? part.asset.format ?? part.asset.assetId}
        />
      )

    case "derived-media":
      return (
        <div className="rounded-lg border px-3 py-2 text-sm">
          <div className="font-medium">Derived media · {part.operation}</div>
          <div className="text-muted-foreground">
            {part.sourceAssetIds.length} source
            {part.sourceAssetIds.length === 1 ? "" : "s"} →{" "}
            {part.outputAssetIds.length} output
            {part.outputAssetIds.length === 1 ? "" : "s"}
          </div>
        </div>
      )

    case "file":
      return (
        <AssetLabel
          kind={`File · ${part.purpose}`}
          assetId={part.asset.assetId}
          detail={part.asset.fileName ?? part.asset.assetId}
        />
      )

    case "source":
      return (
        <a
          className="text-sm underline underline-offset-4"
          href={part.url}
          target="_blank"
          rel="noreferrer"
        >
          {part.title || part.url}
        </a>
      )

    case "tool":
      return (
        <div className="rounded-lg border px-3 py-2 text-sm">
          <div className="font-medium">Tool · {part.toolName}</div>
          <div className="text-muted-foreground">{part.state}</div>
        </div>
      )

    case "generation":
      return (
        <div className="rounded-lg border px-3 py-2 text-sm">
          <div className="font-medium">{part.operation}</div>
          <div className="text-muted-foreground">
            {part.state}
            {part.progress !== undefined
              ? ` · ${Math.round(part.progress * 100)}%`
              : ""}
          </div>
          {part.error ? (
            <div className="mt-1 text-destructive">{part.error.message}</div>
          ) : null}
        </div>
      )

    case "provenance":
      return null

    case "identity":
      return (
        <div className="text-xs text-muted-foreground">
          {part.label ?? part.identity.kind}
        </div>
      )

    case "error":
      return (
        <div className="rounded-lg border border-destructive/30 px-3 py-2 text-sm text-destructive">
          {part.message}
        </div>
      )

    default:
      return assertNever(part)
  }
}

export function ConversationMessageView({
  message,
}: {
  message: ConversationMessage
}) {
  return (
    <div data-role={message.role} className="space-y-2">
      {message.parts.map((part) => (
        <ConversationPartView key={part.id} part={part} />
      ))}
    </div>
  )
}
