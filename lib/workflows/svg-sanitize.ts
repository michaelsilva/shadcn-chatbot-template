/**
 * `service.svgPreview`: produces the "safe preview" representation
 * #7/#18 require alongside every untrusted SVG original — never the
 * same object, never a substitute for real DOM-isolated rendering.
 *
 * Workers (workerd) has no DOM/XML parser available, so this is a
 * regex-based stripper covering the well-known SVG XSS vectors
 * (script execution, event handlers, embedded foreign HTML,
 * `javascript:`-scheme references, external resource loading). It is a
 * reasonable baseline for a durable "safe preview" asset, not a
 * substitute for a real sanitizer/isolated-render pipeline — #18 owns
 * evaluating whether a full sanitizer library belongs in the eventual
 * inline-rendering path.
 */

const DANGEROUS_TAGS = ["script", "foreignObject", "iframe", "embed", "object", "use"]

function stripTags(svg: string, tagNames: readonly string[]): string {
  let result = svg
  for (const tag of tagNames) {
    // Paired tags (with content) and self-closing tags, case-insensitive.
    result = result.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), "")
    result = result.replace(new RegExp(`<${tag}[^>]*\\/>`, "gi"), "")
  }
  return result
}

function stripEventHandlerAttributes(svg: string): string {
  // on<word>="..." or on<word>='...' anywhere in a tag.
  return svg.replace(/\son[a-z]+\s*=\s*(".*?"|'.*?')/gi, "")
}

function stripDangerousUrlAttributes(svg: string): string {
  // href / xlink:href / src pointing at javascript: or external http(s) — a
  // safe preview never fetches or executes anything at render time. Local
  // fragment refs (#id) and inline data: URIs are left alone.
  return svg.replace(
    /\s(href|xlink:href|src)\s*=\s*(".*?"|'.*?')/gi,
    (match, attr: string, quoted: string) => {
      const value = quoted.slice(1, -1).trim()
      if (value.startsWith("#") || value.startsWith("data:")) return match
      return ""
    }
  )
}

function stripStyleBlocks(svg: string): string {
  // @import can fetch external stylesheets; expression()/javascript: in
  // inline style attributes are legacy but cheap to also strip.
  return svg
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, (block) =>
      block.replace(/@import[^;]*;?/gi, "")
    )
    .replace(/\sstyle\s*=\s*(".*?"|'.*?')/gi, (match) =>
      /expression\s*\(|javascript:/i.test(match) ? "" : match
    )
}

export interface SvgSanitizeResult {
  sanitizedSvg: string
  removedConstructs: readonly string[]
}

export function sanitizeSvgForPreview(source: string): SvgSanitizeResult {
  const removed: string[] = []

  let result = source
  const beforeTags = result
  result = stripTags(result, DANGEROUS_TAGS)
  if (result !== beforeTags) removed.push("dangerous-tags")

  const beforeHandlers = result
  result = stripEventHandlerAttributes(result)
  if (result !== beforeHandlers) removed.push("event-handler-attributes")

  const beforeUrls = result
  result = stripDangerousUrlAttributes(result)
  if (result !== beforeUrls) removed.push("external-or-script-url-references")

  const beforeStyle = result
  result = stripStyleBlocks(result)
  if (result !== beforeStyle) removed.push("style-based-vectors")

  return { sanitizedSvg: result.trim(), removedConstructs: removed }
}
