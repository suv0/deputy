import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DeputyLine } from '../types'

// Set DEPUTY_BIN to deputy's bin/deputy.mjs if `deputy` is not on PATH (npm link puts it there).
const line = atom({ plugin: 'deputy-status', key: 'line' } as const, null)

async function deputy($: EngineInterface, args: string[]) {
  const bin = await $.env.get('DEPUTY_BIN')
  return bin ? ['node', bin, ...args] : ['deputy', ...args]
}

async function refresh($: EngineInterface) {
  const argv = await deputy($, ['status', '--json'])
  let next: DeputyLine
  try {
    const r = await $.process.run(argv, { timeoutMs: 10_000 })
    const j = JSON.parse(r.stdout.trim())
    next = { line: j.line, color: j.color, links: j.links ?? [], readAt: await $.clock.now() }
  } catch {
    next = { line: 'deputy: status unreadable', color: 'error', links: [], readAt: await $.clock.now() }
  }
  await update($, line, () => next)
}

// Splits the line around each link's text, so every PR number becomes its own button.
function pieces(text: string, links: DeputyLine['links']) {
  const out: (string | { label: string; href: string })[] = []
  let rest = text
  for (;;) {
    let first: { at: number; link: DeputyLine['links'][number] } | null = null
    for (const link of links) {
      const at = rest.indexOf(link.text)
      if (at >= 0 && (first === null || at < first.at)) first = { at, link }
    }
    if (first === null) break
    if (first.at > 0) out.push(rest.slice(0, first.at))
    out.push({ label: first.link.text, href: first.link.href })
    rest = rest.slice(first.at + first.link.text.length)
  }
  if (rest) out.push(rest)
  return out
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await refresh($)
    $.clock.every(30_000, () => refresh($))
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, line)
    if (e.props.hasSurvey || current === null) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    // The desktop app draws Link elements in this band as plain text, so each PR is a button that
    // opens it through `deputy open` (explorer.exe, open or xdg-open, by platform).
    const open = async (href: string) => {
      try { await $.process.run(await deputy($, ['open', href]), { timeoutMs: 10_000 }) } catch {}
    }
    return (
      <Box>
        <Text color={current.color}>● </Text>
        {pieces(current.line, current.links).map((part, i) =>
          typeof part === 'string' ? (
            <Text key={`t${i}`} dimColor>
              {part}
            </Text>
          ) : (
            <Button key={`b${i}`} label={part.label} onPress={() => open(part.href)} />
          ),
        )}
      </Box>
    )
  })
}
