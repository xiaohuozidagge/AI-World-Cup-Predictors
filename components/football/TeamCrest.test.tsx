import { test } from "node:test"
import assert from "node:assert/strict"
import { renderToStaticMarkup } from "react-dom/server"

import { TeamCrest } from "./TeamCrest"

test("renders the localized crest for a Premier League team", () => {
  const html = renderToStaticMarkup(<TeamCrest slug="arsenal-fc" name="Arsenal FC" />)
  assert.match(html, /<img /)
  assert.match(html, /src="\/images\/teams\/premier-league\/2026-27\/arsenal-fc\.png"/)
  assert.match(html, /alt="Arsenal FC crest"/)
  assert.match(html, /width="200"/)
  assert.match(html, /height="200"/)
})

test("resolves by team id when no slug is provided", () => {
  // Arsenal FC's teamId from the crest manifest.
  const html = renderToStaticMarkup(
    <TeamCrest teamId="289df2d8-edae-4b48-b4cd-d522a6a5ac7b" name="Arsenal FC" />,
  )
  assert.match(html, /src="\/images\/teams\/premier-league\/2026-27\/arsenal-fc\.png"/)
})

test("renders a monogram fallback for a non-Premier-League team", () => {
  const html = renderToStaticMarkup(<TeamCrest slug="real-madrid-cf" name="Real Madrid CF" />)
  assert.doesNotMatch(html, /<img /)
  assert.match(html, /role="img"/)
  assert.match(html, /aria-label="Real Madrid CF crest"/)
  assert.match(html, />RM</)
})

test("decorative crests are hidden from assistive technology", () => {
  const img = renderToStaticMarkup(<TeamCrest slug="arsenal-fc" name="Arsenal FC" decorative />)
  assert.match(img, /alt=""/)
  assert.doesNotMatch(img, /alt="Arsenal FC crest"/)

  const mono = renderToStaticMarkup(<TeamCrest slug="real-madrid-cf" name="Real Madrid CF" decorative />)
  assert.match(mono, /aria-hidden="true"/)
  assert.doesNotMatch(mono, /role="img"/)
})

test("the fixed-size container prevents layout shift", () => {
  const sm = renderToStaticMarkup(<TeamCrest slug="arsenal-fc" name="Arsenal FC" size="sm" />)
  assert.match(sm, /h-8 w-8/)
  const lg = renderToStaticMarkup(<TeamCrest slug="arsenal-fc" name="Arsenal FC" size="lg" />)
  assert.match(lg, /h-12 w-12/)
  const xl = renderToStaticMarkup(<TeamCrest slug="arsenal-fc" name="Arsenal FC" size="xl" />)
  assert.match(xl, /h-16 w-16/)
})

test("crests keep aspect ratio without stretching or circular cropping", () => {
  const html = renderToStaticMarkup(<TeamCrest slug="arsenal-fc" name="Arsenal FC" />)
  assert.match(html, /object-contain/)
  assert.doesNotMatch(html, /rounded-full/)
})

test("priority crests load eagerly and non-priority lazily", () => {
  const eager = renderToStaticMarkup(<TeamCrest slug="arsenal-fc" name="Arsenal FC" priority />)
  assert.match(eager, /loading="eager"/)
  const lazy = renderToStaticMarkup(<TeamCrest slug="arsenal-fc" name="Arsenal FC" />)
  assert.match(lazy, /loading="lazy"/)
})
