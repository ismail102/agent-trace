// The pane's drawing. Three views of the turn on show, each a picture where
// the surface draws SVG and cells or blocks in the terminal:
//
//   Map       the hub and its stations, pulses out and back (mapsvg, braille)
//   Timeline  swimlanes with concurrency, causality links and a live playhead
//   Insights  where the time went, tokens per step, slowest calls, turns
//
// Under each: the span list, the inspector, and the detail kept. Every function
// here is pure: handlers come in as `act`.

import type { Category, Filter, Lane, Mode, Span, Tier, Turn, View } from '../types'
import { brailleCells, brailleSize } from './braille'
import { insightsSvg, insightsText } from './insights'
import { describeMap, esc, mapSvg } from './mapsvg'
import { COLORS, ERR, INK, LIVE, WAIT } from './palette'
import { NAMES, STATIONS, buildScene, isMarker } from './scene'
import { formatMs, formatTokens, turnLength } from './trace'

export { COLORS } from './palette'

/** The surface's element table, as `$.ui.resolve(e)` answered it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Els = any

export type Act = {
  setTier: (tier: Tier) => void
  setFilter: (filter: Filter) => void
  setMode: (mode: Mode) => void
  select: (id: string) => void
  older: () => void
  newer: () => void
  copy: (span: Span) => void
  clear: () => void
}

/** The key the terminal's map Raster is drawn and blitted under. */
export const MAP_KEY = 'map'

const MODES: [Mode, string][] = [
  ['map', '◉ Map'],
  ['timeline', '▤ Timeline'],
  ['insights', '▦ Insights'],
]

const FILTERS: [Filter, string][] = [
  ['all', 'All'],
  ['model', 'Model'],
  ['files', 'Files'],
  ['shell', 'Shell'],
  ['network', 'Network'],
  ['agents', 'Agents'],
  ['hooks', 'Hooks'],
  ['you', 'Needs you'],
  ['err', 'Errors'],
]

const TIERS: [Tier, string][] = [
  ['names', 'Names only'],
  ['masked', 'Masked args'],
  ['full', 'Full input'],
]

const TIER_NOTES: Record<Tier, string> = {
  names:
    'Names only: tool, file, host and program names are kept. New calls are captured this way; earlier ones keep the detail they were captured with.',
  masked:
    'Masked args: arguments are kept with secrets hidden and long text replaced by its length. Applies to calls from now on.',
  full: 'Full input: whole arguments are kept in this session’s memory only, never written to disk. Applies to calls from now on.',
}

const STATUS: Record<Span['status'], string> = {
  ok: 'Done',
  err: 'Failed',
  wait: 'Waited on you',
  run: 'Running',
}

export function matches(span: Span, filter: Filter): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'err':
      return span.status === 'err'
    case 'you':
      return span.status === 'wait' || span.cat === 'you' || span.waitFrom !== undefined
    case 'agents':
      return span.cat === 'agents' || !['main', 'events', 'bg'].includes(span.lane)
    default:
      return span.cat === filter
  }
}

function end(span: Span, len: number): number {
  return span.t1 ?? len
}

function fillOf(span: Span): string {
  if (span.status === 'err') return ERR

  return COLORS[span.cat]
}

/** A tick step that gives at most eight ticks over the turn. */
function tickStep(len: number): number {
  const steps = [250, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000]

  return steps.find(s => len / s <= 8) ?? 1_200_000
}

function tickLabel(ms: number, step: number): string {
  if (step < 1000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`

  return `${Math.floor(ms / 60_000)}m${ms % 60_000 ? `${Math.round((ms % 60_000) / 1000)}s` : ''}`
}

function clip(text: string, chars: number): string {
  if (chars <= 1) return ''

  return text.length > chars ? `${text.slice(0, chars - 1)}…` : text
}

const r1 = (n: number) => Math.round(n * 10) / 10

/** How many calls were in flight at each of `n` moments across the turn. */
export function concurrency(turn: Turn, len: number, n: number): number[] {
  const out = new Array<number>(n).fill(0)
  for (const s of turn.spans) {
    if (isMarker(s) || s.cat === 'model') continue
    const a = Math.floor((s.t0 / len) * n)
    const b = Math.min(n - 1, Math.floor((end(s, len) / len) * n))
    for (let i = Math.max(0, a); i <= b; i += 1) out[i] = (out[i] ?? 0) + 1
  }

  return out
}

/** The model step a call came from, by the `parent` it was given. */
function stepOf(turn: Turn, span: Span): Span | undefined {
  const m = /· step (\d+)$/.exec(span.parent ?? '')
  if (!m) return undefined
  const lane = span.lane === 'bg' ? 'main' : span.lane

  return turn.spans.find(s => s.lane === lane && s.cat === 'model' && s.label === `step ${m[1]}`)
}

const SVG_LIMIT = 125_000

/** The timeline as one SVG document, for desktop, VS Code and mobile. */
export function timelineSvg(turn: Turn, now: number, view: View, sel: Span | undefined, lite = false): string {
  const len = Math.max(turnLength(turn, now), 1000)
  const step = tickStep(len)
  const scale = Math.ceil(len / step) * step
  const W = 760
  const L = 168
  const AXIS = 16
  const CONC = 30
  const TOP = AXIS + CONC + 10
  const LANE = 32
  const H = TOP + turn.lanes.length * (LANE + 4) + 8
  const x = (ms: number) => L + (Math.min(ms, scale) / scale) * (W - L - 8)
  const parts: string[] = []
  const live = turn.endedMs === undefined
  const spans = lite ? turn.spans.slice(-300) : turn.spans
  const laneY = new Map(turn.lanes.map((l, i) => [l.id, TOP + i * (LANE + 4)]))

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Inter, system-ui, -apple-system, Segoe UI, sans-serif">`,
    '<defs>',
    `<pattern id="wait" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="4" height="8" fill="${WAIT}"/><rect x="4" width="4" height="8" fill="#B87A08"/></pattern>`,
    // Running bars: light stripes that march, so a live bar reads as live at a glance.
    `<pattern id="run" width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(-35)"><rect width="5" height="12" fill="#FFFFFF" opacity="0.22"/>${
      live ? `<animateTransform attributeName="patternTransform" type="translate" from="0 0" to="12 0" dur="0.8s" repeatCount="indefinite" additive="sum"/>` : ''
    }</pattern>`,
    ...(Object.keys(COLORS) as Category[]).map(
      c => `<linearGradient id="g-${c}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${COLORS[c]}"/><stop offset="1" stop-color="${COLORS[c]}" stop-opacity="0.72"/></linearGradient>`,
    ),
    `<linearGradient id="g-err" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${ERR}"/><stop offset="1" stop-color="${ERR}" stop-opacity="0.72"/></linearGradient>`,
    `<linearGradient id="conc" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9CC7FF" stop-opacity="0.75"/><stop offset="1" stop-color="#9CC7FF" stop-opacity="0.05"/></linearGradient>`,
    '<filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>',
    '</defs>',
    `<rect width="${W}" height="${H}" rx="8" fill="${INK.ground}"/>`,
  )

  // Ticks.
  for (let t = 0; t <= scale; t += step) {
    const tx = x(t)
    const anchor = t === 0 ? 'start' : t >= scale ? 'end' : 'middle'
    parts.push(
      `<line x1="${r1(tx)}" y1="${AXIS}" x2="${r1(tx)}" y2="${H - 4}" stroke="${INK.line}" stroke-width="1"/>`,
      `<text x="${r1(tx)}" y="11" font-size="10" fill="${INK.dim}" text-anchor="${anchor}" font-family="JetBrains Mono, Consolas, monospace">${tickLabel(t, step)}</text>`,
    )
  }

  // Concurrency: how many calls ran at once, as an area.
  const N = 140
  const conc = concurrency(turn, scale, N)
  const peak = Math.max(1, ...conc)
  const cy0 = AXIS + CONC
  const pts = conc.map((c, i) => `${r1(x((i / N) * scale))},${r1(cy0 - (c / peak) * (CONC - 4))}`)
  parts.push(
    `<text x="10" y="${AXIS + 12}" font-size="10" font-weight="700" letter-spacing="1" fill="${INK.dim}">IN FLIGHT</text>`,
    `<text x="10" y="${AXIS + 25}" font-size="10" fill="${INK.dim}">peak ${Math.max(...conc)} at once</text>`,
    `<path d="M${r1(x(0))},${cy0} L${pts.join(' L')} L${r1(x(scale))},${cy0} Z" fill="url(#conc)"/>`,
    `<polyline points="${pts.join(' ')}" fill="none" stroke="#9CC7FF" stroke-width="1.2"/>`,
    `<line x1="${L}" y1="${cy0}" x2="${W - 8}" y2="${cy0}" stroke="${INK.faint}"/>`,
  )

  // Lanes.
  turn.lanes.forEach((lane, i) => {
    const y = TOP + i * (LANE + 4)
    const isSub = !['main', 'events', 'bg'].includes(lane.id)
    const dot = lane.id === 'main' ? COLORS.model : lane.id === 'events' ? COLORS.hooks : lane.id === 'bg' ? COLORS.shell : COLORS.agents
    parts.push(
      `<circle cx="14" cy="${y + 11}" r="3.5" fill="${dot}"/>`,
      `<text x="24" y="${y + 14}" font-size="12" font-weight="600" fill="${INK.text}">${esc(clip(lane.name, 20))}</text>`,
      `<text x="24" y="${y + 27}" font-size="10" fill="${INK.dim}">${esc(clip(lane.sub, 26))}</text>`,
      `<rect x="${L}" y="${y}" width="${W - L - 8}" height="${LANE}" rx="5" fill="${INK.well}"${isSub ? ` stroke="${COLORS.agents}" stroke-opacity="0.18"` : ''}/>`,
    )
  })

  // Causality: model step to the calls it asked for; an Agent call to its subagent's lane.
  if (!lite) {
    const links: string[] = []
    for (const s of spans) {
      if (s.cat === 'model' || isMarker(s)) continue
      const from = stepOf(turn, s)
      const ys = laneY.get(s.lane)
      if (!from || ys === undefined) continue
      const yf = laneY.get(from.lane)
      if (yf === undefined) continue
      const x0 = x(end(from, len))
      const x1 = x(s.t0)
      if (yf === ys) {
        // Same lane: a small hop over the row.
        if (x1 - x0 < 6) continue
        links.push(`<path d="M${r1(x0)},${yf + 4} Q${r1((x0 + x1) / 2)},${yf - 7} ${r1(x1)},${ys + 4}" fill="none" stroke="${COLORS.model}" stroke-width="1" opacity="0.45"/>`)
      } else {
        const ym = (yf + ys) / 2 + LANE / 2
        links.push(`<path d="M${r1(x0)},${yf + LANE / 2} C${r1(x0 + 14)},${ym} ${r1(x1 - 14)},${ym} ${r1(x1)},${ys + LANE / 2}" fill="none" stroke="${COLORS.model}" stroke-width="1" opacity="0.4"/>`)
      }
    }
    // The k-th Agent call spawned the k-th subagent lane.
    const agentCalls = turn.spans.filter(s => s.lane === 'main' && (s.tool === 'Agent' || s.tool === 'Task')).sort((a, b) => a.t0 - b.t0)
    const subLanes = turn.lanes.filter(l => !['main', 'events', 'bg'].includes(l.id))
    subLanes.forEach((lane, k) => {
      const call = agentCalls[k]
      const first = turn.spans.filter(s => s.lane === lane.id).sort((a, b) => a.t0 - b.t0)[0]
      const ya = laneY.get('main')
      const yb = laneY.get(lane.id)
      if (!call || !first || ya === undefined || yb === undefined) return
      const x0 = x(call.t0) + 4
      const x1 = x(first.t0)
      links.push(
        `<path d="M${r1(x0)},${ya + LANE - 5} C${r1(x0)},${yb + LANE / 2} ${r1(x0)},${yb + LANE / 2} ${r1(Math.max(x1, x0 + 4))},${yb + LANE / 2}" fill="none" stroke="${COLORS.agents}" stroke-width="1.3" stroke-dasharray="3 3" opacity="0.75"/>`,
      )
    })
    parts.push(...links)
  }

  // Bars.
  for (const span of spans) {
    const y = laneY.get(span.lane)
    if (y === undefined) continue
    const x0 = x(span.t0)
    const w = Math.max(x(end(span, len)) - x0, 3)
    const dim = matches(span, view.filter) ? 1 : 0.18
    const isSel = sel?.id === span.id
    const grad = span.status === 'err' ? 'url(#g-err)' : `url(#g-${span.cat})`
    const dur = end(span, len) - span.t0
    const tip = `${span.label} · ${NAMES[span.cat]} · ${formatMs(dur)}${span.t1 === undefined ? ' so far' : ''} · ${STATUS[span.status]}`

    if (isMarker(span)) {
      // A mark: a diamond on the Events lane.
      const cy = y + LANE / 2
      const c = span.status === 'err' ? ERR : COLORS[span.cat]
      parts.push(
        `<g opacity="${dim}">${lite ? '' : `<title>${esc(tip)}</title>`}<path d="M${r1(x0)},${cy - 7} L${r1(x0 + 7)},${cy} L${r1(x0)},${cy + 7} L${r1(x0 - 7)},${cy} Z" fill="${c}"${isSel ? ' stroke="#FFFFFF" stroke-width="2"' : ''}/></g>`,
      )
      continue
    }

    parts.push(
      `<g opacity="${dim}">`,
      lite ? '' : `<title>${esc(tip)}</title>`,
      `<rect x="${r1(x0)}" y="${y + 5}" width="${r1(w)}" height="${LANE - 10}" rx="4" fill="${grad}"${isSel ? ' stroke="#FFFFFF" stroke-width="2" filter="url(#glow)"' : ''}/>`,
    )
    if (span.waitFrom !== undefined) {
      const wx = x(span.waitFrom)
      const ww = Math.max(x(span.waitTo ?? end(span, len)) - wx, 3)
      parts.push(`<rect x="${r1(wx)}" y="${y + 5}" width="${r1(ww)}" height="${LANE - 10}" rx="4" fill="url(#wait)"/>`)
    }
    if (span.status === 'run') {
      parts.push(
        `<rect x="${r1(x0)}" y="${y + 5}" width="${r1(w)}" height="${LANE - 10}" rx="4" fill="url(#run)"/>`,
        `<rect x="${r1(x0 + w - 3)}" y="${y + 5}" width="3" height="${LANE - 10}" fill="#FFFFFF" opacity="0.85" filter="url(#glow)"/>`,
      )
    }
    if (span.status === 'err' && w > 14) {
      parts.push(`<text x="${r1(x0 + w - 8)}" y="${y + 20}" text-anchor="middle" font-size="11" font-weight="700" fill="#2A0909">✕</text>`)
    }
    const chars = Math.floor((w - (span.status === 'err' ? 20 : 10)) / 6.4)
    if (!lite && chars >= 4) {
      parts.push(`<text x="${r1(x0 + 5)}" y="${y + 20}" font-size="11" font-weight="600" fill="${INK.well}">${esc(clip(span.label, chars))}</text>`)
    }
    parts.push('</g>')
  }

  // Selection crosshair and the live playhead.
  if (sel) {
    const px = x(sel.t0)
    parts.push(`<line x1="${r1(px)}" y1="${AXIS}" x2="${r1(px)}" y2="${H - 4}" stroke="${INK.text}" stroke-opacity="0.45" stroke-dasharray="2 3"/>`)
  }
  if (live) {
    const px = x(len)
    parts.push(
      `<line x1="${r1(px)}" y1="${AXIS}" x2="${r1(px)}" y2="${H - 4}" stroke="${LIVE}" stroke-width="1.5" opacity="0.85"/>`,
      `<circle cx="${r1(px)}" cy="${AXIS}" r="4" fill="${LIVE}"><animate attributeName="r" values="3;6;3" dur="1.4s" repeatCount="indefinite"/><animate attributeName="opacity" values="1;0.4;1" dur="1.4s" repeatCount="indefinite"/></circle>`,
    )
  }
  parts.push('</svg>')

  const svg = parts.join('')
  if (svg.length > SVG_LIMIT && !lite) return timelineSvg(turn, now, view, sel, true)

  return svg
}

type Cell = { ch: string; color: string; dim: boolean }

/** The timeline as rows of coloured block characters, for the terminal. */
function timelineRows(Box: Els, Text: Els, turn: Turn, now: number, view: View, columns: number, sel: Span | undefined) {
  const len = Math.max(turnLength(turn, now), 1000)
  const LABEL = 12
  const width = Math.max(16, columns - LABEL - 1)
  const at = (ms: number) => Math.min(width - 1, Math.max(0, Math.floor((ms / len) * width)))

  const step = tickStep(len)
  const axis = Array.from({ length: width }, () => ' ')
  for (let t = 0; t <= len; t += step) {
    const label = tickLabel(t, step)
    const pos = Math.min(width - label.length, at(t))
    for (let i = 0; i < label.length; i += 1) axis[pos + i] = label.charAt(i)
  }

  const SPARK = ' ▁▂▃▄▅▆▇█'
  const conc = concurrency(turn, len, width)
  const peak = Math.max(1, ...conc)
  const spark = conc.map(c => SPARK[Math.round((c / peak) * 8)]).join('')

  const rows = turn.lanes.map(lane => {
    const cells: Cell[] = Array.from({ length: width }, () => ({ ch: '·', color: '#3A4150', dim: true }))
    for (const span of turn.spans) {
      if (span.lane !== lane.id) continue
      const a = at(span.t0)
      const b = Math.max(a, at(end(span, len)))
      const shown = matches(span, view.filter)
      const glyph = isMarker(span) ? '◆' : sel?.id === span.id ? '▓' : '█'
      for (let i = a; i <= b; i += 1) {
        const ms = (i / width) * len
        const inWait = span.waitFrom !== undefined && ms >= span.waitFrom && ms <= (span.waitTo ?? len)
        cells[i] = {
          ch: inWait ? '▒' : glyph,
          color: inWait ? WAIT : fillOf(span),
          dim: !shown,
        }
      }
    }

    return { lane, cells }
  })

  // Runs of the same style become one Text each.
  const runs = (cells: Cell[]) => {
    const out: Cell[] = []
    for (const c of cells) {
      const last = out[out.length - 1]
      if (last && last.color === c.color && last.dim === c.dim) last.ch += c.ch
      else out.push({ ...c })
    }

    return out
  }

  const pad = (s: string) => (s.length >= LABEL ? `${s.slice(0, LABEL - 1)}…` : s.padEnd(LABEL))

  return (
    <Box flexDirection="column">
      <Text dimColor>
        {' '.repeat(LABEL + 1)}
        {axis.join('')}
      </Text>
      <Box flexDirection="row">
        <Text dimColor>{pad('in flight')} </Text>
        <Text color="#9CC7FF">{spark}</Text>
      </Box>
      {rows.map(({ lane, cells }) => (
        <Box key={`lane-${lane.id}`} flexDirection="row">
          <Text bold>{pad(lane.name)} </Text>
          {runs(cells).map(r => (
            <Text color={r.color} dimColor={r.dim}>
              {r.ch}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  )
}

function stats(turn: Turn, now: number): [string, string, string | undefined][] {
  const u = turn.usage
  const scene = buildScene(turn, now)

  return [
    ['Turn time', formatMs(turnLength(turn, now)), undefined],
    ['Model steps', String(turn.steps), undefined],
    ['Tool calls', String(turn.tools), undefined],
    ['Errors', String(turn.errors), turn.errors > 0 ? ERR : undefined],
    ['Waited on you', formatMs(turn.waitedMs), turn.waitedMs > 0 ? WAIT : undefined],
    ['Parallelism', `${scene.parallelism.toFixed(1)}×`, scene.parallelism > 1.2 ? '#9CC7FF' : undefined],
    [
      'Tokens',
      `${formatTokens(u.input + u.cacheRead + u.cacheWrite)} in · ${formatTokens(u.output)} out`,
      undefined,
    ],
  ]
}

function laneName(lanes: Lane[], id: string): string {
  return lanes.find(l => l.id === id)?.name ?? id
}

function inspector(els: Els, span: Span | undefined, turn: Turn, now: number, act: Act, isTerminal: boolean) {
  const { Box, Text, Button } = els
  if (!span) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="#3A4150" paddingX={1}>
        <Text dimColor>Select a span to inspect it.</Text>
      </Box>
    )
  }
  const len = turnLength(turn, now)
  const dur = end(span, len) - span.t0
  const from = stepOf(turn, span)

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#3A4150" paddingX={1} gap={isTerminal ? 0 : 1}>
      <Text color={fillOf(span)}>
        ■ <Text dimColor>{NAMES[span.cat]} · {laneName(turn.lanes, span.lane)}</Text>
      </Text>
      <Text bold>
        {span.label}{' '}
        <Text color={span.status === 'err' ? ERR : span.status === 'wait' ? WAIT : span.status === 'run' ? '#9CC7FF' : '#8FE3B0'}>
          [{STATUS[span.status]}]
        </Text>
      </Text>
      <Text>
        <Text dimColor>Started </Text>
        {formatMs(span.t0)}
        <Text dimColor>   Duration </Text>
        {span.t1 === undefined ? `${formatMs(dur)}…` : formatMs(dur)}
        {len > 0 && !isMarker(span) ? <Text dimColor>   {Math.round((dur / len) * 100)}% of the turn</Text> : ''}
      </Text>
      {span.parent !== undefined && (
        <Text>
          <Text dimColor>Issued by </Text>
          {span.parent}
          {from !== undefined && from.t1 !== undefined ? <Text dimColor> (it ended at {formatMs(from.t1)})</Text> : ''}
        </Text>
      )}
      {span.tokens !== undefined && (
        <Text>
          <Text dimColor>Tokens </Text>
          {span.tokens}
        </Text>
      )}
      {span.waitFrom !== undefined && (
        <Text color={WAIT}>
          Waited on you {formatMs(Math.max(0, (span.waitTo ?? len) - span.waitFrom))}
          {span.waitTo === undefined ? ' (still waiting)' : ''}
        </Text>
      )}
      {span.risk !== undefined && <Text color={WAIT}>Risk signal: {span.risk}</Text>}
      {span.input !== undefined && (
        <Box flexDirection="column">
          <Text dimColor>Input · captured as {TIERS.find(t => t[0] === span.tier)?.[1]}</Text>
          <Text mono wrap="wrap">
            {span.input}
          </Text>
        </Box>
      )}
      {span.result !== undefined && (
        <Box flexDirection="column">
          <Text dimColor>Result</Text>
          <Text wrap="wrap">{span.result}</Text>
        </Box>
      )}
      <Box flexDirection="row" gap={1}>
        <Button key="copy-json" label="Copy as JSON" onPress={() => act.copy(span)} />
      </Box>
    </Box>
  )
}

/** Under the map: a chip per station that was used, each a filter for the list below. */
function stationChips(els: Els, turn: Turn, now: number, view: View, act: Act) {
  const { Box, Button } = els
  const scene = buildScene(turn, now)
  const used = scene.stations.filter(s => s.count > 0)

  return (
    <Box flexDirection="row" flexWrap="wrap" gap={1}>
      <Button key="f-all" label="All" variant={view.filter === 'all' ? 'primary' : 'secondary'} onPress={() => act.setFilter('all')} />
      {used.map(s => (
        <Button
          key={`f-${s.cat}`}
          label={`${NAMES[s.cat]} ${s.count}${s.running.length ? ' ●' : ''}`}
          variant={view.filter === s.cat ? 'primary' : 'secondary'}
          onPress={() => act.setFilter(s.cat)}
        />
      ))}
      {turn.errors > 0 && (
        <Button key="f-err" label={`Errors ${turn.errors}`} variant={view.filter === 'err' ? 'primary' : 'secondary'} onPress={() => act.setFilter('err')} />
      )}
    </Box>
  )
}

/** The terminal's map: the braille Raster where it fits, its stations in words either way. */
function terminalMap(els: Els, turn: Turn, now: number, columns: number, rows: number) {
  const { Box, Text, Raster } = els
  const size = Raster ? brailleSize(columns, rows) : undefined
  const scene = buildScene(turn, now)
  const used = scene.stations.filter(s => s.count > 0).sort((a, b) => b.busyMs - a.busyMs)

  return (
    <Box flexDirection="column">
      {size && <Raster key={MAP_KEY} columns={size.columns} rows={size.rows} cells={brailleCells(turn, now, size.columns, size.rows)} />}
      <Text>
        {used.length === 0 ? <Text dimColor>No calls yet.</Text> : ''}
        {used.map((s, i) => (
          <Text>
            {i > 0 ? <Text dimColor>  </Text> : ''}
            <Text color={COLORS[s.cat]}>■</Text> {NAMES[s.cat]} {s.count}
            <Text dimColor> {formatMs(s.busyMs)}</Text>
            {s.running.length > 0 ? <Text color={LIVE}> ▶{s.running.length}</Text> : ''}
            {s.errors > 0 ? <Text color={ERR}> ✕{s.errors}</Text> : ''}
          </Text>
        ))}
      </Text>
      {scene.waitingFrom.length > 0 && <Text color={WAIT}>Waiting on you: {scene.waitingFrom.map(c => NAMES[c]).join(', ')}</Text>}
    </Box>
  )
}

export function drawPane(
  els: Els,
  surface: string,
  turns: Turn[],
  view: View,
  now: number,
  columns: number,
  rows: number,
  act: Act,
) {
  const { Box, Text, Button, Svg } = els
  const isTerminal = surface === 'terminal' || Svg === undefined
  const mode: Mode = view.mode ?? 'map'

  if (turns.length === 0) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Agent Trace</Text>
        <Text dimColor>No turns yet. Send a prompt and its model steps, tool calls, subagents, hooks and permission waits appear here live.</Text>
        {tierRow(els, view, act)}
      </Box>
    )
  }

  const index = Math.max(0, turns.length - 1 - Math.min(view.back, turns.length - 1))
  const turn = turns[index]!
  const shown = turn.spans.filter(s => matches(s, view.filter))
  const sel = turn.spans.find(s => s.id === view.sel) ?? shown[shown.length - 1]
  const running = turn.endedMs === undefined

  let body
  if (mode === 'map') {
    body = (
      <Box flexDirection="column" gap={isTerminal ? 0 : 1}>
        {isTerminal ? terminalMap(els, turn, now, columns, rows) : <Svg source={mapSvg(turn, now)} alt={describeMap(turn, now)} isInteractive />}
        {stationChips(els, turn, now, view, act)}
      </Box>
    )
  } else if (mode === 'timeline') {
    body = (
      <Box flexDirection="column" gap={isTerminal ? 0 : 1}>
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {FILTERS.map(([id, label]) => (
            <Button key={`f-${id}`} label={label} variant={view.filter === id ? 'primary' : 'secondary'} onPress={() => act.setFilter(id)} />
          ))}
        </Box>
        {isTerminal ? (
          timelineRows(Box, Text, turn, now, view, columns, sel)
        ) : (
          <Svg
            source={timelineSvg(turn, now, view, sel)}
            alt={`Timeline of turn ${index + 1}: ${turn.spans.length} spans across ${turn.lanes.length} lanes, ${formatMs(turnLength(turn, now))}.`}
            isInteractive
          />
        )}
        <Text dimColor>
          {STATIONS.map(c => (
            <Text>
              <Text color={COLORS[c]}>■</Text> {NAMES[c]}{'  '}
            </Text>
          ))}
          <Text color={WAIT}>▒</Text> Waiting on you{'  '}
          <Text color={ERR}>■</Text> Failed
        </Text>
      </Box>
    )
  } else {
    body = isTerminal ? (
      insightsText(els, turns, turn, now, columns)
    ) : (
      <Svg source={insightsSvg(turns, turn, now)} alt={`Insights for turn ${index + 1}: time by kind of work, tokens per step, slowest calls, recent turns.`} isInteractive />
    )
  }

  return (
    <Box flexDirection="column" gap={isTerminal ? 0 : 1}>
      <Box flexDirection="row" justifyContent="space-between" flexWrap="wrap" gap={1}>
        <Text>
          <Text bold>Agent Trace</Text>
          <Text dimColor>
            {'  '}Turn {index + 1} of {turns.length}
          </Text>
          {running ? <Text color={LIVE}> · live</Text> : <Text dimColor>{turn.reason && turn.reason !== 'answer' ? ` · ${turn.reason}` : ''}</Text>}
        </Text>
        <Box flexDirection="row" gap={1}>
          {index > 0 && <Button key="older" label="◀ Older" plain onPress={act.older} />}
          {index < turns.length - 1 && <Button key="newer" label="Newer ▶" plain onPress={act.newer} />}
          <Button key="clear" label="Clear" plain onPress={act.clear} />
        </Box>
      </Box>

      {isTerminal ? (
        <Text>
          {stats(turn, now).map(([label, value, color], i) => (
            <Text>
              {i > 0 ? <Text dimColor> · </Text> : ''}
              <Text dimColor>{label} </Text>
              <Text bold color={color}>
                {value}
              </Text>
            </Text>
          ))}
        </Text>
      ) : (
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {stats(turn, now).map(([label, value, color]) => (
            <Box key={`stat-${label}`} flexDirection="column" borderStyle="round" borderColor="#262B36" paddingX={1} minWidth={14}>
              <Text size="caption" dimColor>
                {label}
              </Text>
              <Text mono weight="semibold" color={color}>
                {value}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      <Box flexDirection="row" gap={1}>
        {MODES.map(([id, label]) => (
          <Button key={`m-${id}`} label={label} variant={mode === id ? 'primary' : 'secondary'} onPress={() => act.setMode(id)} />
        ))}
      </Box>

      {body}

      <Box flexDirection="column">
        <Text dimColor>
          Spans ({shown.length}
          {view.filter === 'all' ? '' : ` of ${turn.spans.length}`}), newest first
        </Text>
        {shown
          .slice(-40)
          .reverse()
          .map(s => (
            <Button key={`s-${s.id}`} plain onPress={() => act.select(s.id)}>
              {sel?.id === s.id ? '› ' : '  '}
              <Text color={fillOf(s)}>■</Text> {s.label}{' '}
              <Text dimColor>
                {laneName(turn.lanes, s.lane)} · {formatMs(s.t0)}
                {s.status === 'run' ? ' · running' : s.status === 'err' ? ' · failed' : s.waitFrom !== undefined ? ' · waited' : ''}
              </Text>
            </Button>
          ))}
      </Box>

      {inspector(els, sel, turn, now, act, isTerminal)}

      {tierRow(els, view, act)}
    </Box>
  )
}

function tierRow(els: Els, view: View, act: Act) {
  const { Box, Text, Button } = els

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        <Text dimColor>Detail kept</Text>
        {TIERS.map(([id, label]) => (
          <Button
            key={`t-${id}`}
            label={label}
            variant={view.tier === id ? 'primary' : 'secondary'}
            onPress={() => act.setTier(id)}
          />
        ))}
      </Box>
      <Text dimColor wrap="wrap">
        {TIER_NOTES[view.tier]}
      </Text>
    </Box>
  )
}
