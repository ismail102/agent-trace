// The Insights view: where the time went, tokens per model step, the slowest
// calls and the recent turns side by side. An SVG on desktop, VS Code and
// mobile; bars of eighth blocks in the terminal. Pure.

import type { Category, Span, Turn } from '../types'
import { esc } from './mapsvg'
import { COLORS, ERR, INK, TOKENS, WAIT } from './palette'
import { NAMES, STATIONS, buildScene, isMarker } from './scene'
import { formatMs, formatTokens, turnLength } from './trace'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Els = any

const f = (n: number) => (Math.round(n * 10) / 10).toString()
const mono = 'JetBrains Mono, Consolas, monospace'

export type Insight = {
  byCat: { cat: Category; ms: number; count: number; errors: number }[]
  steps: { label: string; lane: string; cache: number; input: number; output: number }[]
  slowest: { span: Span; ms: number; waited: number }[]
  turns: { turn: Turn; len: number; byCat: Partial<Record<Category, number>>; errors: number }[]
}

function busyByCat(turn: Turn, now: number): Partial<Record<Category, number>> {
  const out: Partial<Record<Category, number>> = {}
  const len = turnLength(turn, now)
  for (const s of turn.spans) {
    if (isMarker(s)) continue
    out[s.cat] = (out[s.cat] ?? 0) + Math.max(0, (s.t1 ?? len) - s.t0)
  }

  return out
}

export function insightOf(turns: Turn[], turn: Turn, now: number): Insight {
  const scene = buildScene(turn, now)
  const len = turnLength(turn, now)

  const byCat = scene.stations
    .filter(s => s.count > 0)
    .map(s => ({ cat: s.cat, ms: s.busyMs, count: s.count, errors: s.errors }))
    .sort((a, b) => b.ms - a.ms)

  const steps = turn.spans
    .filter(s => s.cat === 'model')
    .sort((a, b) => a.t0 - b.t0)
    .map(s => ({
      label: s.label,
      lane: s.lane,
      cache: s.tokCache ?? 0,
      input: s.tokIn ?? 0,
      output: s.tokOut ?? 0,
    }))

  const slowest = turn.spans
    .filter(s => !isMarker(s) && s.cat !== 'model')
    .map(s => ({
      span: s,
      ms: Math.max(0, (s.t1 ?? len) - s.t0),
      waited: s.waitFrom !== undefined ? Math.max(0, (s.waitTo ?? len) - s.waitFrom) : 0,
    }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 6)

  const recent = turns.slice(-12).map(t => ({
    turn: t,
    len: turnLength(t, now),
    byCat: busyByCat(t, now),
    errors: t.errors,
  }))

  return { byCat, steps, slowest, turns: recent }
}

function heading(x: number, y: number, text: string, note = ''): string {
  return `<text x="${x}" y="${y}" font-size="10" font-weight="700" letter-spacing="1.3" fill="${INK.dim}">${esc(text)}</text>${
    note ? `<text x="${760 - 16}" y="${y}" text-anchor="end" font-size="10" fill="${INK.dim}">${esc(note)}</text>` : ''
  }`
}

/** The Insights view of one turn among the recent ones, as an SVG document. */
export function insightsSvg(turns: Turn[], turn: Turn, now: number): string {
  const ins = insightOf(turns, turn, now)
  const W = 760
  const parts: string[] = []
  let y = 26

  // 1. Where the time went.
  parts.push(heading(16, y, 'WHERE THE TIME WENT', 'busy time per kind of work; overlapping calls each count'))
  y += 14
  const maxMs = Math.max(1, ...ins.byCat.map(c => c.ms))
  const barX = 112
  const barW = 430
  if (ins.byCat.length === 0) {
    parts.push(`<text x="16" y="${y + 14}" font-size="11" fill="${INK.dim}">Nothing has run yet.</text>`)
    y += 24
  }
  for (const c of ins.byCat) {
    const w = Math.max(2, (c.ms / maxMs) * barW)
    parts.push(
      `<g><title>${esc(`${NAMES[c.cat]}: ${formatMs(c.ms)} over ${c.count} call${c.count === 1 ? '' : 's'}${c.errors ? `, ${c.errors} failed` : ''}`)}</title>`,
      `<circle cx="22" cy="${y + 9}" r="4" fill="${COLORS[c.cat]}"/>`,
      `<text x="32" y="${y + 13}" font-size="11.5" fill="${INK.text}">${NAMES[c.cat]}</text>`,
      `<rect x="${barX}" y="${y + 2}" width="${barW}" height="14" rx="3" fill="${INK.well}"/>`,
      `<rect x="${barX}" y="${y + 2}" width="${f(w)}" height="14" rx="3" fill="url(#g-${c.cat})"/>`,
      `<text x="${barX + barW + 10}" y="${y + 13}" font-size="11" fill="${INK.text}" font-family="${mono}">${esc(formatMs(c.ms))}</text>`,
      `<text x="${barX + barW + 76}" y="${y + 13}" font-size="10.5" fill="${INK.dim}">${c.count} call${c.count === 1 ? '' : 's'}</text>`,
      c.errors ? `<text x="${W - 16}" y="${y + 13}" text-anchor="end" font-size="10.5" font-weight="700" fill="${ERR}">${c.errors} failed</text>` : '',
      '</g>',
    )
    y += 20
  }
  y += 18

  // 2. Tokens per model step: input up, output down, each to its own scale.
  parts.push(heading(16, y, 'TOKENS PER MODEL STEP', 'input above the line, output below, each to its own scale'))
  y += 12
  const chartH = 64
  const axisY = y + chartH
  const steps = ins.steps.slice(-48)
  if (steps.length === 0 || steps.every(s => s.cache + s.input + s.output === 0)) {
    parts.push(`<text x="16" y="${y + 18}" font-size="11" fill="${INK.dim}">No token counts yet: they arrive as each model step ends.</text>`)
    y += 34
  } else {
    const maxIn = Math.max(1, ...steps.map(s => s.cache + s.input))
    const maxOut = Math.max(1, ...steps.map(s => s.output))
    const plotX = 60
    const plotW = W - plotX - 16
    const slot = plotW / Math.max(steps.length, 8)
    const bw = Math.max(3, Math.min(26, slot * 0.7))
    parts.push(
      `<text x="${plotX - 8}" y="${y + 9}" text-anchor="end" font-size="9.5" fill="${INK.dim}" font-family="${mono}">${formatTokens(maxIn)}</text>`,
      `<text x="${plotX - 8}" y="${axisY + 4}" text-anchor="end" font-size="9.5" fill="${INK.dim}">0</text>`,
      `<text x="${plotX - 8}" y="${axisY + 34}" text-anchor="end" font-size="9.5" fill="${INK.dim}" font-family="${mono}">${formatTokens(maxOut)}</text>`,
      `<line x1="${plotX}" y1="${axisY}" x2="${W - 16}" y2="${axisY}" stroke="${INK.faint}"/>`,
    )
    steps.forEach((s, i) => {
      const x = plotX + i * slot + (slot - bw) / 2
      const hCache = (s.cache / maxIn) * chartH
      const hIn = (s.input / maxIn) * chartH
      const hOut = (s.output / maxOut) * 30
      const tip = `${s.lane === 'main' ? 'Main loop' : 'Subagent'} ${s.label}: ${formatTokens(s.cache)} from cache, ${formatTokens(s.input)} new in, ${formatTokens(s.output)} out`
      parts.push(
        `<g opacity="${s.lane === 'main' ? 1 : 0.6}"><title>${esc(tip)}</title>`,
        `<rect x="${f(x)}" y="${f(axisY - hCache)}" width="${f(bw)}" height="${f(hCache)}" fill="${TOKENS.cache}"/>`,
        `<rect x="${f(x)}" y="${f(axisY - hCache - hIn)}" width="${f(bw)}" height="${f(hIn)}" rx="1.5" fill="${TOKENS.input}"/>`,
        `<rect x="${f(x)}" y="${axisY + 1}" width="${f(bw)}" height="${f(Math.max(1, hOut))}" rx="1.5" fill="${TOKENS.output}"/>`,
        '</g>',
      )
    })
    y = axisY + 46
    parts.push(
      `<g font-size="10" fill="${INK.dim}">`,
      `<rect x="${plotX}" y="${y - 9}" width="10" height="10" fill="${TOKENS.cache}"/><text x="${plotX + 15}" y="${y}">from cache</text>`,
      `<rect x="${plotX + 92}" y="${y - 9}" width="10" height="10" fill="${TOKENS.input}"/><text x="${plotX + 107}" y="${y}">new input</text>`,
      `<rect x="${plotX + 178}" y="${y - 9}" width="10" height="10" fill="${TOKENS.output}"/><text x="${plotX + 193}" y="${y}">output</text>`,
      `<text x="${plotX + 252}" y="${y}">faded: a subagent's step</text>`,
      '</g>',
    )
    y += 12
  }
  y += 22

  // 3. Slowest calls, with the part spent waiting on you hatched.
  parts.push(heading(16, y, 'SLOWEST CALLS', 'hatched: waiting on you'))
  y += 12
  const maxSlow = Math.max(1, ...ins.slowest.map(s => s.ms))
  if (ins.slowest.length === 0) {
    parts.push(`<text x="16" y="${y + 14}" font-size="11" fill="${INK.dim}">No tool calls yet.</text>`)
    y += 24
  }
  for (const s of ins.slowest) {
    const w = Math.max(2, (s.ms / maxSlow) * 330)
    const ww = s.ms > 0 ? (s.waited / s.ms) * w : 0
    const color = s.span.status === 'err' ? ERR : COLORS[s.span.cat]
    const label = s.span.label.length > 34 ? `${s.span.label.slice(0, 33)}…` : s.span.label
    parts.push(
      `<g><title>${esc(`${s.span.label}: ${formatMs(s.ms)}${s.waited ? `, ${formatMs(s.waited)} of it waiting on you` : ''}`)}</title>`,
      `<text x="16" y="${y + 13}" font-size="11.5" fill="${INK.text}">${esc(label)}</text>`,
      `<rect x="${290}" y="${y + 3}" width="${f(w)}" height="12" rx="3" fill="${color}" opacity="0.85"/>`,
      ww > 1 ? `<rect x="${f(290 + (w - ww))}" y="${y + 3}" width="${f(ww)}" height="12" rx="3" fill="url(#hatch)"/>` : '',
      `<text x="${f(290 + w + 8)}" y="${y + 13}" font-size="11" fill="${INK.dim}" font-family="${mono}">${esc(formatMs(s.ms))}${s.span.t1 === undefined ? '…' : ''}</text>`,
      '</g>',
    )
    y += 19
  }
  y += 22

  // 4. Recent turns: height is length, colour is where the time went.
  parts.push(heading(16, y, 'RECENT TURNS', 'height: turn length · colour: busy time by kind · ring: the one on show'))
  y += 14
  const colH = 70
  const maxLen = Math.max(1, ...ins.turns.map(t => t.len))
  const slotW = Math.min(56, (W - 32) / Math.max(1, ins.turns.length))
  ins.turns.forEach((t, i) => {
    const x = 16 + i * slotW + 6
    const bw = slotW - 12
    const h = Math.max(4, (t.len / maxLen) * colH)
    const total = Object.values(t.byCat).reduce((a, b) => a + (b ?? 0), 0)
    let top = y + colH
    const isOn = t.turn.id === turn.id
    parts.push(`<g><title>${esc(`Turn ${turns.length - ins.turns.length + i + 1}: ${formatMs(t.len)}, ${t.turn.tools} call${t.turn.tools === 1 ? '' : 's'}, ${t.errors} error${t.errors === 1 ? '' : 's'}`)}</title>`)
    parts.push(`<rect x="${f(x)}" y="${f(y + colH - h)}" width="${f(bw)}" height="${f(h)}" rx="3" fill="${INK.well}"/>`)
    for (const cat of STATIONS) {
      const ms = t.byCat[cat] ?? 0
      if (ms <= 0 || total <= 0) continue
      const hh = (ms / total) * h
      top -= hh
      parts.push(`<rect x="${f(x)}" y="${f(top)}" width="${f(bw)}" height="${f(hh)}" fill="${COLORS[cat]}" opacity="0.9"/>`)
    }
    if (isOn) parts.push(`<rect x="${f(x - 3)}" y="${f(y + colH - h - 3)}" width="${f(bw + 6)}" height="${f(h + 6)}" rx="5" fill="none" stroke="${INK.text}" stroke-width="1.5"/>`)
    if (t.errors > 0) parts.push(`<circle cx="${f(x + bw / 2)}" cy="${f(y + colH - h - 10)}" r="4" fill="${ERR}"/>`)
    parts.push(
      `<text x="${f(x + bw / 2)}" y="${y + colH + 14}" text-anchor="middle" font-size="9.5" fill="${isOn ? INK.text : INK.dim}" font-family="${mono}">${esc(formatMs(t.len).replace(' ', ''))}</text>`,
      '</g>',
    )
  })
  y += colH + 30

  const H = y
  const defs = [
    '<defs>',
    ...(Object.keys(COLORS) as Category[]).map(
      c => `<linearGradient id="g-${c}" x1="0" x2="1"><stop offset="0" stop-color="${COLORS[c]}" stop-opacity="0.55"/><stop offset="1" stop-color="${COLORS[c]}"/></linearGradient>`,
    ),
    `<pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="3" height="6" fill="${WAIT}"/><rect x="3" width="3" height="6" fill="#8A5A06"/></pattern>`,
    '</defs>',
  ]

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Inter, system-ui, -apple-system, Segoe UI, sans-serif">`,
    ...defs,
    `<rect width="${W}" height="${H}" rx="10" fill="${INK.ground}"/>`,
    ...parts,
    '</svg>',
  ].join('')
}

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

/** A bar `frac` of `width` cells long, in eighth blocks. */
export function bar(frac: number, width: number): string {
  const eighths = Math.round(Math.max(0, Math.min(1, frac)) * width * 8)

  return '█'.repeat(Math.floor(eighths / 8)) + EIGHTHS[eighths % 8]
}

/** The Insights view in the terminal: bars of blocks, a sparkline of tokens. */
export function insightsText(els: Els, turns: Turn[], turn: Turn, now: number, columns: number) {
  const { Box, Text } = els
  const ins = insightOf(turns, turn, now)
  const width = Math.max(10, Math.min(40, columns - 34))
  const maxMs = Math.max(1, ...ins.byCat.map(c => c.ms))
  const maxSlow = Math.max(1, ...ins.slowest.map(s => s.ms))
  const SPARK = '▁▂▃▄▅▆▇█'
  const steps = ins.steps.slice(-Math.max(8, columns - 20))
  const maxIn = Math.max(1, ...steps.map(s => s.cache + s.input))
  const spark = steps.map(s => SPARK[Math.min(7, Math.floor(((s.cache + s.input) / maxIn) * 7.99))]).join('')
  const maxLen = Math.max(1, ...ins.turns.map(t => t.len))
  const turnSpark = ins.turns.map(t => SPARK[Math.min(7, Math.floor((t.len / maxLen) * 7.99))]).join('')

  return (
    <Box flexDirection="column">
      <Text bold>Where the time went</Text>
      {ins.byCat.length === 0 && <Text dimColor>Nothing has run yet.</Text>}
      {ins.byCat.map(c => (
        <Text>
          <Text color={COLORS[c.cat]}>{NAMES[c.cat].padEnd(12)}</Text>
          <Text color={COLORS[c.cat]}>{bar(c.ms / maxMs, width).padEnd(width + 1)}</Text>
          {formatMs(c.ms).padStart(8)} <Text dimColor>{c.count} calls</Text>
          {c.errors ? <Text color={ERR}> {c.errors} failed</Text> : ''}
        </Text>
      ))}
      <Text> </Text>
      <Text bold>
        Input tokens per step <Text dimColor>(max {formatTokens(maxIn)})</Text>
      </Text>
      <Text color={TOKENS.input}>{spark || '–'}</Text>
      <Text> </Text>
      <Text bold>Slowest calls</Text>
      {ins.slowest.length === 0 && <Text dimColor>No tool calls yet.</Text>}
      {ins.slowest.map(s => (
        <Text>
          <Text color={s.span.status === 'err' ? ERR : COLORS[s.span.cat]}>{bar(s.ms / maxSlow, width).padEnd(width + 1)}</Text>
          {formatMs(s.ms).padStart(8)} {s.span.label}
          {s.waited > 0 ? <Text color={WAIT}> (waited {formatMs(s.waited)})</Text> : ''}
        </Text>
      ))}
      <Text> </Text>
      <Text>
        <Text bold>Recent turns </Text>
        <Text color="#9CC7FF">{turnSpark}</Text>
        <Text dimColor> longest {formatMs(maxLen)}</Text>
      </Text>
    </Box>
  )
}
