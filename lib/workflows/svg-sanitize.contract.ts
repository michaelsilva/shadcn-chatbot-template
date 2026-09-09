import { sanitizeSvgForPreview } from "./svg-sanitize"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

export function runSvgSanitizeContractChecks() {
  const withScript = sanitizeSvgForPreview(
    '<svg><script>alert(document.cookie)</script><circle r="1"/></svg>'
  )
  assert(!withScript.sanitizedSvg.includes("<script"), "script tags are removed")
  assert(withScript.sanitizedSvg.includes("<circle"), "safe sibling content is preserved")
  assert(withScript.removedConstructs.includes("dangerous-tags"), "removal is reported")

  const withHandler = sanitizeSvgForPreview('<svg onload="fetch(1)"><rect onclick="x()"/></svg>')
  assert(!/onload/i.test(withHandler.sanitizedSvg), "onload handler is removed")
  assert(!/onclick/i.test(withHandler.sanitizedSvg), "onclick handler is removed")

  const withForeignObject = sanitizeSvgForPreview(
    '<svg><foreignObject><body onload="x()">hi</body></foreignObject></svg>'
  )
  assert(
    !withForeignObject.sanitizedSvg.includes("foreignObject"),
    "foreignObject (embedded arbitrary HTML) is removed"
  )

  const withJsHref = sanitizeSvgForPreview(
    '<svg><a href="javascript:alert(1)"><text>click</text></a></svg>'
  )
  assert(!/javascript:/i.test(withJsHref.sanitizedSvg), "javascript: URLs are stripped")

  const withExternalRef = sanitizeSvgForPreview(
    '<svg><image href="https://evil.example/track.png"/></svg>'
  )
  assert(
    !withExternalRef.sanitizedSvg.includes("evil.example"),
    "external http(s) references are stripped from a safe preview"
  )

  const withSafeFragmentRef = sanitizeSvgForPreview(
    '<svg><defs><linearGradient id="g"/></defs><rect fill="url(#g)"/><use href="#g"/></svg>'
  )
  // `<use>` itself is a dangerous tag (can reference external/foreign
  // content), so it's stripped — but a same-document fragment reference
  // used as a plain attribute value (fill="url(#g)") is untouched.
  assert(withSafeFragmentRef.sanitizedSvg.includes('fill="url(#g)"'), "same-document fragment refs used as attribute values survive")
  assert(!withSafeFragmentRef.sanitizedSvg.includes("<use"), "<use> elements are stripped (can reference external content)")

  const withDataUri = sanitizeSvgForPreview(
    '<svg><image href="data:image/png;base64,iVBORw0KGgo="/></svg>'
  )
  assert(withDataUri.sanitizedSvg.includes("data:image/png"), "inline data: URIs are preserved")

  const clean = sanitizeSvgForPreview('<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>')
  assert(clean.removedConstructs.length === 0, "clean input reports nothing removed")
  assert(clean.sanitizedSvg.includes("<circle"), "clean input is preserved as-is")

  const withImportStyle = sanitizeSvgForPreview(
    '<svg><style>@import url(https://evil.example/x.css); circle{fill:red}</style><circle/></svg>'
  )
  assert(!/@import/i.test(withImportStyle.sanitizedSvg), "@import in <style> is stripped")
  assert(withImportStyle.sanitizedSvg.includes("fill:red"), "the rest of the stylesheet is preserved")

  return true
}

void runSvgSanitizeContractChecks()
