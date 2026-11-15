// The map as an animated SVG, for desktop, VS Code and mobile.
//
// The hub is the main loop; every kind of work is a station around it. A call
// sends a pulse out along its spoke while it runs and a comet back when it
// ends; spokes thicken with use; the ring round the hub shows where the
// turn's time went and the thin ring outside it the tokens. Subagents are
// satellites beyond Agents, with their own mix of calls. A call that waits on
// you draws an amber line to You until you answer.
//
// The pane redraws once a second while a turn runs. Every animation is begun
// at a negative offset worked out from the clock, so each redraw carries on
// from where the last one stood instead of starting over.

import type { Turn } from '../types'
import { COLORS, ERR, INK, LIVE, TOKENS, WAIT } from './palette'
import {
  AFTERGLOW_MS,
  CX,
  CY,
  HUB_R,
  MAP_H,
  MAP_W,
  NAMES,
  PULSE_MS,
  RING,
  STATIONS,
  buildScene,
  ORBIT,
  legPoints,
  pathLength,
  pulsePhase,
  spoke,
  stationPoint,
} from './scene'
import type { Point, Station } from './scene'
import { formatMs, formatTokens } from './trace'

const f = (n: number) => (Math.round(n * 10) / 10).toString()
const sec = (ms: number) => `${f(ms / 1000)}s`

export function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function polyPath(pts: Point[]): string {
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${f(p.x)} ${f(p.y)}`).join(' ')
}

function curvePath(q: { a: Point; c: Point; b: Point }): string {
  return `M${f(q.a.x)} ${f(q.a.y)} Q${f(q.c.x)} ${f(q.c.y)} ${f(q.b.x)} ${f(q.b.y)}`
}

/** An arc of a circle, angles in radians clockwise from the right. */
export function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const sweep = Math.min(a1 - a0, Math.PI * 2 - 0.0001)
  const x0 = cx + Math.cos(a0) * r
  const y0 = cy + Math.sin(a0) * r
  const x1 = cx + Math.cos(a0 + sweep) * r
  const y1 = cy + Math.sin(a0 + sweep) * r

  return `M${f(x0)} ${f(y0)} A${f(r)} ${f(r)} 0 ${sweep > Math.PI ? 1 : 0} 1 ${f(x1)} ${f(y1)}`
}

/** A ring cut into segments by share, drawn clockwise from the top. */
function ring(cx: number, cy: number, r: number, width: number, parts: { share: number; color: string; title?: string }[]): string {
  const out: string[] = [`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${INK.line}" stroke-width="${width}"/>`]
  let a = -Math.PI / 2
  for (const p of parts) {
    if (p.share <= 0.002) continue
    const span = p.share * Math.PI * 2
    const gap = parts.filter(x => x.share > 0.002).length > 1 ? 0.03 : 0
    out.push(
      `<path d="${arcPath(cx, cy, r, a + gap / 2, a + span - gap / 2)}" fill="none" stroke="${p.color}" stroke-width="${width}">${p.title ? `<title>${esc(p.title)}</title>` : ''}</path>`,
    )
    a += span
  }

  return out.join('')
}

function begin(msAgo: number): string {
  return `${f(-msAgo / 1000)}s`
}

function drawStation(st: Station, out: string[]): void {
  const color = COLORS[st.cat]
  const used = st.count > 0
  const { x, y } = st.at
  const tip = `${NAMES[st.cat]}: ${st.count} ${st.count === 1 ? 'call' : 'calls'}, ${formatMs(st.busyMs)}, ${Math.round(st.share * 100)}% of busy time${st.errors ? `, ${st.errors} failed` : ''}${st.waits ? `, ${st.waits} waited on you` : ''}`

  out.push(`<g><title>${esc(tip)}</title>`)

  if (st.running.length > 0) {
    // A breathing halo and a turning dashed ring while something runs here.
    const t = st.running[0]!.ms
    out.push(
      `<circle cx="${f(x)}" cy="${f(y)}" r="${f(st.r + 9)}" fill="${color}" opacity="0.12"><animate attributeName="r" values="${f(st.r + 6)};${f(st.r + 13)};${f(st.r + 6)}" dur="1.8s" begin="${begin(t % 1800)}" repeatCount="indefinite"/></circle>`,
      `<circle cx="${f(x)}" cy="${f(y)}" r="${f(st.r + 6)}" fill="none" stroke="${color}" stroke-width="1.5" stroke-dasharray="3 5" opacity="0.8"><animateTransform attributeName="transform" type="rotate" from="0 ${f(x)} ${f(y)}" to="360 ${f(x)} ${f(y)}" dur="4s" begin="${begin(t % 4000)}" repeatCount="indefinite"/></circle>`,
    )
    // How long the longest call here has run: an arc that fills over 30 s.
    const longest = Math.max(...st.running.map(r => r.ms))
    const frac = (longest % 30_000) / 30_000
    if (frac > 0.01) {
      out.push(
        `<path d="${arcPath(x, y, st.r + 11, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2)}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>`,
      )
    }
  }

  if (st.flash) {
    const ago = Math.min(...st.returning.filter(r => r.span.status === 'err').map(r => r.ago))
    out.push(
      `<circle cx="${f(x)}" cy="${f(y)}" r="${f(st.r)}" fill="none" stroke="${ERR}" stroke-width="3" opacity="0"><animate attributeName="r" values="${f(st.r)};${f(st.r + 22)}" dur="1.2s" begin="${begin(ago)}" fill="freeze"/><animate attributeName="opacity" values="0.9;0" dur="1.2s" begin="${begin(ago)}" fill="freeze"/></circle>`,
    )
  }

  out.push(
    `<circle cx="${f(x)}" cy="${f(y)}" r="${f(st.r)}" fill="${used ? color : INK.ground}" fill-opacity="${used ? 0.16 : 1}" stroke="${used ? color : INK.faint}" stroke-width="${used ? 2 : 1.2}"/>`,
    `<text x="${f(x)}" y="${f(y + 4.5)}" text-anchor="middle" font-size="${st.count > 99 ? 10 : 13}" font-weight="700" fill="${used ? INK.text : INK.faint}" font-family="JetBrains Mono, Consolas, monospace">${used ? st.count : '·'}</text>`,
  )

  // The name outside the ring, then time and share.
  const lx = x + st.dir.x * (st.r + 16)
  const ly = y + st.dir.y * (st.r + 16)
  const anchor = Math.abs(st.dir.x) < 0.3 ? 'middle' : st.dir.x > 0 ? 'start' : 'end'
  const top = st.dir.y < -0.6
  const nameY = top ? ly - 12 : st.dir.y > 0.6 ? ly + 10 : ly - 2
  out.push(
    `<text x="${f(lx)}" y="${f(nameY)}" text-anchor="${anchor}" font-size="12" font-weight="600" fill="${used ? INK.text : INK.dim}">${NAMES[st.cat]}</text>`,
  )
  if (used) {
    out.push(
      `<text x="${f(lx)}" y="${f(nameY + 13)}" text-anchor="${anchor}" font-size="10" fill="${INK.dim}" font-family="JetBrains Mono, Consolas, monospace">${esc(formatMs(st.busyMs))} · ${Math.round(st.share * 100)}%</text>`,
    )
  }

  // Badges: failures top right, waits on you top left.
  const bx = st.r * 0.75
  if (st.errors > 0) {
    out.push(
      `<circle cx="${f(x + bx)}" cy="${f(y - bx)}" r="7.5" fill="${ERR}"/>`,
      `<text x="${f(x + bx)}" y="${f(y - bx + 3.5)}" text-anchor="middle" font-size="9.5" font-weight="700" fill="#1A0B0B">${st.errors}</text>`,
    )
  }
  if (st.waits > 0) {
    out.push(
      `<circle cx="${f(x - bx)}" cy="${f(y - bx)}" r="7.5" fill="${WAIT}"/>`,
      `<text x="${f(x - bx)}" y="${f(y - bx + 3.5)}" text-anchor="middle" font-size="9.5" font-weight="700" fill="#1A1206">${st.waits}</text>`,
    )
  }
  if (st.running.length > 1) {
    out.push(
      `<text x="${f(x + st.r + 4)}" y="${f(y + st.r + 4)}" font-size="10" font-weight="700" fill="${color}">×${st.running.length}</text>`,
    )
  }
  out.push('</g>')

}

/** The animated map of one turn, as an SVG document. */
export function mapSvg(turn: Turn, now: number): string {
  const scene = buildScene(turn, now)
  const out: string[] = []
  const mono = 'JetBrains Mono, Consolas, monospace'

  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MAP_W} ${MAP_H}" width="${MAP_W}" height="${MAP_H}" font-family="Inter, system-ui, -apple-system, Segoe UI, sans-serif">`,
    '<defs>',
    `<radialGradient id="bg" cx="50%" cy="50%" r="60%"><stop offset="0" stop-color="#1A2030"/><stop offset="1" stop-color="${INK.ground}"/></radialGradient>`,
    `<radialGradient id="core" cx="50%" cy="40%" r="70%"><stop offset="0" stop-color="#1B2232"/><stop offset="1" stop-color="${INK.well}"/></radialGradient>`,
    '<filter id="glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="2.6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>',
    '</defs>',
    `<rect width="${MAP_W}" height="${MAP_H}" rx="10" fill="url(#bg)"/>`,
  )

  // Radar rings and faint bearings.
  for (const r of [RING * 0.52, RING, RING + 52]) {
    out.push(`<circle cx="${CX}" cy="${CY}" r="${f(r)}" fill="none" stroke="${INK.line}" stroke-width="1" stroke-dasharray="${r === RING ? '' : '2 6'}" opacity="0.8"/>`)
  }
  for (const cat of STATIONS) {
    const p = stationPoint(cat, RING + 52)
    out.push(`<line x1="${CX}" y1="${CY}" x2="${f(p.x)}" y2="${f(p.y)}" stroke="${INK.line}" stroke-width="0.6" opacity="0.5"/>`)
  }

  // The route the main loop took, newest leg drawing itself in.
  // Older legs ride inside newer ones so they never sit on top of each other.
  scene.route.forEach((leg, i) => {
    const age = scene.route.length - 1 - i
    const pts = legPoints(leg.from, leg.to, ORBIT - age * 5)
    const isNewest = age === 0
    const fade = Math.max(0.12, 1 - leg.age / 90_000) * (0.3 + (0.6 * (i + 1)) / scene.route.length)
    const len = pathLength(pts)
    out.push(
      `<path d="${polyPath(pts)}" fill="none" stroke="${INK.text}" stroke-width="${isNewest ? 1.8 : 1.1}" opacity="${f(fade)}" stroke-linecap="round" stroke-linejoin="round"${
        isNewest
          ? ` stroke-dasharray="${f(len)}" stroke-dashoffset="0"><animate attributeName="stroke-dashoffset" from="${f(len)}" to="0" dur="0.9s" begin="${begin(leg.age)}" fill="freeze"/></path>`
          : '/>'
      }`,
    )
    if (isNewest) {
      // An arrowhead where the newest leg arrives.
      const tip = pts[pts.length - 1]!
      const from = pts[pts.length - 2]!
      const a = Math.atan2(tip.y - from.y, tip.x - from.x)
      const p = (da: number) => `${f(tip.x - Math.cos(a + da) * 7)},${f(tip.y - Math.sin(a + da) * 7)}`
      out.push(`<path d="M${p(0.45)} L${f(tip.x)},${f(tip.y)} L${p(-0.45)}" fill="none" stroke="${INK.text}" stroke-width="1.6" opacity="${f(fade)}" stroke-linecap="round"/>`)
    }
  })

  // Spokes: thicker and brighter with use.
  for (const st of scene.stations) {
    const q = spoke(st)
    const color = COLORS[st.cat]
    if (st.count === 0) {
      out.push(`<path d="${curvePath(q)}" fill="none" stroke="${INK.faint}" stroke-width="1" stroke-dasharray="2 5"/>`)
      continue
    }
    const width = 1.2 + Math.min(6.5, Math.log2(1 + st.count) * 1.5)
    const opacity = 0.3 + Math.min(0.6, st.share * 1.2 + st.count / 40)
    out.push(
      `<path d="${curvePath(q)}" fill="none" stroke="${color}" stroke-width="${f(width)}" stroke-linecap="round" opacity="${f(opacity)}"/>`,
    )
  }

  // Waiting on you: an amber line marching from the station to You.
  const you = scene.stations.find(s => s.cat === 'you')!
  for (const cat of scene.waitingFrom) {
    const pts = legPoints(cat, 'you', ORBIT + 12)
    out.push(
      `<path d="${polyPath(pts)}" fill="none" stroke="${WAIT}" stroke-linejoin="round" stroke-width="2.2" stroke-dasharray="6 6" stroke-linecap="round"><animate attributeName="stroke-dashoffset" from="24" to="0" dur="0.8s" begin="${begin(scene.nowRel % 800)}" repeatCount="indefinite"/></path>`,
    )
  }
  if (scene.waitingFrom.length > 0) {
    out.push(
      `<circle cx="${f(you.at.x)}" cy="${f(you.at.y)}" r="${f(you.r + 8)}" fill="none" stroke="${WAIT}" stroke-width="2"><animate attributeName="r" values="${f(you.r + 4)};${f(you.r + 16)}" dur="1.2s" begin="${begin(scene.nowRel % 1200)}" repeatCount="indefinite"/><animate attributeName="opacity" values="1;0" dur="1.2s" begin="${begin(scene.nowRel % 1200)}" repeatCount="indefinite"/></circle>`,
      `<text x="${f(you.at.x - you.r - 14)}" y="${f(you.at.y + 4)}" text-anchor="end" font-size="10.5" font-weight="700" fill="${WAIT}">NEEDS YOU</text>`,
    )
  }

  // Satellites: each subagent, linked to Agents, ringed by its own mix of calls.
  const agents = scene.stations.find(s => s.cat === 'agents')!
  for (const sat of scene.satellites) {
    const color = COLORS.agents
    out.push(
      `<line x1="${f(agents.at.x)}" y1="${f(agents.at.y)}" x2="${f(sat.at.x)}" y2="${f(sat.at.y)}" stroke="${color}" stroke-width="1.4" stroke-dasharray="${sat.isRunning ? '4 4' : '1 4'}" opacity="0.7">${
        sat.isRunning ? `<animate attributeName="stroke-dashoffset" from="16" to="0" dur="0.9s" begin="${begin(scene.nowRel % 900)}" repeatCount="indefinite"/>` : ''
      }</line>`,
    )
    const total = Object.values(sat.byCat).reduce((a, b) => a + (b ?? 0), 0)
    const parts = STATIONS.filter(c => (sat.byCat[c] ?? 0) > 0).map(c => ({
      share: (sat.byCat[c] ?? 0) / Math.max(1, total),
      color: COLORS[c],
      title: `${NAMES[c]}: ${sat.byCat[c]}`,
    }))
    out.push(
      `<g><title>${esc(`${sat.name}${sat.sub ? ` (${sat.sub})` : ''}: ${sat.calls} spans${sat.isRunning ? ', running' : ''}`)}</title>`,
      `<circle cx="${f(sat.at.x)}" cy="${f(sat.at.y)}" r="12" fill="${INK.well}" stroke="${color}" stroke-width="1.5"/>`,
      ring(sat.at.x, sat.at.y, 16, 3.5, parts),
      `<text x="${f(sat.at.x)}" y="${f(sat.at.y + 4)}" text-anchor="middle" font-size="10" font-weight="700" fill="${color}">${esc(sat.name.replace(/^Agent /, ''))}</text>`,
      `<text x="${f(sat.at.x)}" y="${f(sat.at.y + 31)}" text-anchor="middle" font-size="9.5" fill="${INK.dim}">${esc((sat.sub || sat.name).slice(0, 16))}</text>`,
      '</g>',
    )
    if (sat.isRunning) {
      out.push(
        `<circle cx="${f(sat.at.x + 21)}" cy="${f(sat.at.y)}" r="2.5" fill="${color}" filter="url(#glow)"><animateTransform attributeName="transform" type="rotate" from="0 ${f(sat.at.x)} ${f(sat.at.y)}" to="360 ${f(sat.at.x)} ${f(sat.at.y)}" dur="2s" begin="${begin(scene.nowRel % 2000)}" repeatCount="indefinite"/></circle>`,
      )
    }
  }
  if (scene.hiddenAgents > 0) {
    out.push(`<text x="${f(agents.at.x)}" y="${f(Math.min(MAP_H - 8, agents.at.y + 112))}" text-anchor="middle" font-size="10" fill="${INK.dim}">+${scene.hiddenAgents} more agents</text>`)
  }

  // Comets coming home: each call that just ended runs back to the hub and fades.
  for (const st of scene.stations) {
    const path = curvePath(spoke(st))
    for (const r of st.returning.slice(-4)) {
      const color = r.span.status === 'err' ? ERR : COLORS[st.cat]
      out.push(
        `<circle r="3.6" fill="${color}" filter="url(#glow)" opacity="0"><animateMotion path="${path}" keyPoints="1;0" keyTimes="0;1" calcMode="linear" dur="0.9s" begin="${begin(r.ago)}" fill="freeze"/><animate attributeName="opacity" values="1;1;0" keyTimes="0;0.35;1" dur="${AFTERGLOW_MS / 1000}s" begin="${begin(r.ago)}" fill="freeze"/></circle>`,
      )
    }
  }

  // Pulses going out: one per running call, a short tail behind each.
  for (const st of scene.stations) {
    const path = curvePath(spoke(st))
    const color = COLORS[st.cat]
    const n = Math.min(st.running.length, 4)
    st.running.slice(0, n).forEach((r, k) => {
      const at = pulsePhase(r.ms, k, n) * PULSE_MS
      for (const [lag, size, op] of [
        [0, 4.4, 1],
        [90, 3.2, 0.55],
        [180, 2.2, 0.3],
      ] as const) {
        out.push(
          `<circle r="${size}" fill="${color}" opacity="${op}"${lag === 0 ? ' filter="url(#glow)"' : ''}><animateMotion path="${path}" dur="${PULSE_MS / 1000}s" begin="${begin(at - lag)}" repeatCount="indefinite"/></circle>`,
        )
      }
    })
  }

  for (const st of scene.stations) drawStation(st, out)

  // The hub: where the time went, the tokens, the clock.
  const u = turn.usage
  const tokIn = u.input + u.cacheRead + u.cacheWrite
  const tokAll = Math.max(1, tokIn + u.output)
  out.push(
    `<circle cx="${CX}" cy="${CY}" r="${HUB_R + 22}" fill="none" stroke="${INK.line}" stroke-width="1"/>`,
    ring(
      CX,
      CY,
      HUB_R + 10,
      9,
      scene.stations.map(s => ({ share: s.share, color: COLORS[s.cat], title: `${NAMES[s.cat]} ${Math.round(s.share * 100)}% of busy time` })),
    ),
    ring(CX, CY, HUB_R + 19, 3, [
      { share: u.cacheRead / tokAll, color: TOKENS.cache, title: `${formatTokens(u.cacheRead)} tokens read from cache` },
      { share: (u.input + u.cacheWrite) / tokAll, color: TOKENS.input, title: `${formatTokens(u.input + u.cacheWrite)} new input tokens` },
      { share: u.output / tokAll, color: TOKENS.output, title: `${formatTokens(u.output)} output tokens` },
    ]),
    `<circle cx="${CX}" cy="${CY}" r="${HUB_R}" fill="url(#core)" stroke="${INK.faint}" stroke-width="1.2"/>`,
  )
  if (scene.isLive) {
    out.push(
      `<circle cx="${CX}" cy="${CY}" r="${HUB_R}" fill="none" stroke="${LIVE}" stroke-width="1.5" opacity="0.5"><animate attributeName="opacity" values="0.6;0.1;0.6" dur="2s" begin="${begin(scene.nowRel % 2000)}" repeatCount="indefinite"/></circle>`,
    )
  }
  out.push(
    `<text x="${CX}" y="${CY - 20}" text-anchor="middle" font-size="8.5" font-weight="700" letter-spacing="1.6" fill="${scene.isLive ? LIVE : INK.dim}">${scene.isLive ? '● LIVE' : 'MAIN LOOP'}</text>`,
    `<text x="${CX}" y="${CY + 5}" text-anchor="middle" font-size="19" font-weight="700" fill="${INK.text}" font-family="${mono}">${esc(sec(scene.len))}</text>`,
    `<text x="${CX}" y="${CY + 20}" text-anchor="middle" font-size="9.5" fill="${INK.dim}">${scene.steps} step${scene.steps === 1 ? '' : 's'}${scene.model ? ` · ${esc(scene.model.slice(0, 14))}` : ''}</text>`,
  )

  // Corner read-outs.
  const busy = scene.totalBusy
  out.push(
    `<text x="16" y="24" font-size="10" font-weight="700" letter-spacing="1.2" fill="${INK.dim}">PARALLELISM</text>`,
    `<text x="16" y="44" font-size="18" font-weight="700" fill="${INK.text}" font-family="${mono}">${f(scene.parallelism)}×</text>`,
    `<text x="16" y="60" font-size="10" fill="${INK.dim}">${esc(formatMs(busy))} of work in ${esc(formatMs(scene.len))}</text>`,
    `<text x="${MAP_W - 16}" y="24" text-anchor="end" font-size="10" font-weight="700" letter-spacing="1.2" fill="${INK.dim}">TOKENS</text>`,
    `<text x="${MAP_W - 16}" y="44" text-anchor="end" font-size="18" font-weight="700" fill="${INK.text}" font-family="${mono}">${formatTokens(tokIn)} <tspan fill="${INK.dim}" font-size="12">in</tspan> ${formatTokens(u.output)} <tspan fill="${INK.dim}" font-size="12">out</tspan></text>`,
    `<text x="${MAP_W - 16}" y="60" text-anchor="end" font-size="10" fill="${INK.dim}">${tokIn > 0 ? Math.round((u.cacheRead / tokIn) * 100) : 0}% of input from cache</text>`,
  )

  // Key.
  const ky = MAP_H - 14
  out.push(
    `<g font-size="10" fill="${INK.dim}">`,
    `<circle cx="20" cy="${ky - 3}" r="3.5" fill="${INK.text}"/><text x="28" y="${ky}">call out</text>`,
    `<circle cx="86" cy="${ky - 3}" r="3.5" fill="none" stroke="${INK.text}"/><text x="94" y="${ky}">result back</text>`,
    `<line x1="164" y1="${ky - 3}" x2="182" y2="${ky - 3}" stroke="${INK.text}" opacity="0.6"/><text x="188" y="${ky}">route</text>`,
    `<line x1="226" y1="${ky - 3}" x2="244" y2="${ky - 3}" stroke="${WAIT}" stroke-width="2" stroke-dasharray="4 3"/><text x="250" y="${ky}">waiting on you</text>`,
    `<circle cx="${MAP_W - 150}" cy="${ky - 3}" r="5" fill="${ERR}"/><text x="${MAP_W - 141}" y="${ky}">failed</text>`,
    `<circle cx="${MAP_W - 92}" cy="${ky - 3}" r="5" fill="${WAIT}"/><text x="${MAP_W - 83}" y="${ky}">asked you</text>`,
    '</g>',
  )

  out.push('</svg>')

  return out.join('')
}

/** One line for a reader that cannot see the map. */
export function describeMap(turn: Turn, now: number): string {
  const scene = buildScene(turn, now)
  const used = scene.stations.filter(s => s.count > 0).sort((a, b) => b.busyMs - a.busyMs)
  const running = scene.stations.filter(s => s.running.length > 0).map(s => NAMES[s.cat])
  const parts = used.slice(0, 5).map(s => `${NAMES[s.cat]} ${s.count} (${formatMs(s.busyMs)})`)

  return `Map of the turn, ${formatMs(scene.len)}${scene.isLive ? ', live' : ''}: ${parts.join(', ') || 'no calls yet'}.${running.length ? ` Running: ${running.join(', ')}.` : ''}${scene.waitingFrom.length ? ' Waiting on you.' : ''}`
}
