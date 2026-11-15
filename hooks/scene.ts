// The map's model: where each station sits, what it has done this turn, and
// what is moving right now. The SVG map and the terminal's braille map both
// draw from this, so they always agree. Nothing here touches the engine.

import type { Category, Span, Turn } from '../types'
import { turnLength } from './trace'

/** The drawing's own units; the SVG uses them as pixels, the braille map scales them to dots. */
export const MAP_W = 760
export const MAP_H = 560

/** Where satellites sit, as turns (radians) off the Agents bearing: beside it first, then further round. */
const SATELLITE_TURNS = [-0.95, 0.95, -1.35, 1.35, -0.62, 0.62]
export const CX = 380
export const CY = 262
/** Distance from the hub to each station. */
export const RING = 188
export const HUB_R = 50

/** Clockwise from the top. `you` sits at the top, `agents` at the bottom, where its satellites have room. */
export const STATIONS: Category[] = ['you', 'model', 'files', 'shell', 'network', 'browser', 'agents', 'memory', 'tools', 'hooks']

export const NAMES: Record<Category, string> = {
  you: 'You',
  model: 'Model',
  memory: 'Memory',
  files: 'Files',
  shell: 'Shell',
  network: 'Network',
  browser: 'Browser',
  agents: 'Agents',
  hooks: 'Hooks',
  tools: 'Other tools',
}

export type Point = { x: number; y: number }

/** How long a finished call's return pulse and flash stay on the map. */
export const AFTERGLOW_MS = 2400
/** How long one outbound pulse takes, hub to station. */
export const PULSE_MS = 1400

export type Station = {
  cat: Category
  at: Point
  /** Unit vector from the hub. */
  dir: Point
  /** Drawn radius: grows with the time spent there. */
  r: number
  count: number
  busyMs: number
  errors: number
  waits: number
  /** Calls running now, each with how long it has run. */
  running: { span: Span; ms: number }[]
  /** Calls that ended in the last AFTERGLOW_MS, with how long ago. */
  returning: { span: Span; ago: number }[]
  /** An error that ended in the last AFTERGLOW_MS. */
  flash: boolean
  /** Share of all busy time, 0 to 1. */
  share: number
}

export type Satellite = {
  id: string
  name: string
  sub: string
  at: Point
  calls: number
  byCat: Partial<Record<Category, number>>
  isRunning: boolean
}

export type Leg = { from: Category; to: Category; age: number }

export type Scene = {
  len: number
  /** Ms since the turn started, as drawn: its end once it is over. */
  nowRel: number
  isLive: boolean
  stations: Station[]
  satellites: Satellite[]
  hiddenAgents: number
  /** The route the main loop took through the stations, oldest leg first. */
  route: Leg[]
  /** Stations waiting on the person now. */
  waitingFrom: Category[]
  totalBusy: number
  /** Busy time over wall time: above 1 means work overlapped. */
  parallelism: number
  steps: number
  model: string
}

/** A zero-length mark on the Events lane: an ask, an answer, the end. */
export function isMarker(s: Span): boolean {
  return s.lane === 'events' && s.t1 === s.t0
}

function angleOf(i: number): number {
  return ((-90 + (i * 360) / STATIONS.length) * Math.PI) / 180
}

export function stationPoint(cat: Category, radius = RING): Point {
  const a = angleOf(STATIONS.indexOf(cat))

  return { x: CX + Math.cos(a) * radius, y: CY + Math.sin(a) * radius }
}

const isSub = (lane: string) => !['main', 'events', 'bg'].includes(lane)

export function buildScene(turn: Turn, now: number): Scene {
  const len = Math.max(turnLength(turn, now), 1)
  const isLive = turn.endedMs === undefined
  const nowRel = len

  const per = new Map<Category, Station>()
  for (const cat of STATIONS) {
    const a = angleOf(STATIONS.indexOf(cat))
    per.set(cat, {
      cat,
      at: stationPoint(cat),
      dir: { x: Math.cos(a), y: Math.sin(a) },
      r: 15,
      count: 0,
      busyMs: 0,
      errors: 0,
      waits: 0,
      running: [],
      returning: [],
      flash: false,
      share: 0,
    })
  }

  let totalBusy = 0
  for (const s of turn.spans) {
    const st = per.get(s.cat)
    if (!st) continue
    // Asks and the end of the turn are marks, not work; your answers count as You.
    if (isMarker(s) && s.cat !== 'you') continue
    if (s.lane === 'events' && s.cat === 'you' && /^(Answer ready|Interrupted|Refused|Ended)/.test(s.label)) continue
    st.count += 1
    const end = s.t1 ?? nowRel
    const busy = Math.max(0, end - s.t0)
    st.busyMs += busy
    totalBusy += busy
    if (s.status === 'err') st.errors += 1
    if (s.waitFrom !== undefined) st.waits += 1
    if (s.t1 === undefined && isLive) st.running.push({ span: s, ms: nowRel - s.t0 })
    if (s.t1 !== undefined && isLive && s.t1 !== s.t0) {
      const ago = nowRel - s.t1
      if (ago >= 0 && ago < AFTERGLOW_MS) {
        st.returning.push({ span: s, ago })
        if (s.status === 'err') st.flash = true
      }
    }
  }

  const stations = STATIONS.map(c => per.get(c)!)
  for (const st of stations) {
    st.share = totalBusy > 0 ? st.busyMs / totalBusy : 0
    st.r = 15 + Math.min(13, Math.sqrt(st.busyMs / 1000) * 4)
  }

  // Subagents: satellites beside the Agents station, either side of its
  // label, which stands straight out from the hub.
  const subLanes = turn.lanes.filter(l => isSub(l.id))
  const shown = subLanes.slice(0, SATELLITE_TURNS.length)
  const agentsAt = per.get('agents')!
  const base = Math.atan2(agentsAt.dir.y, agentsAt.dir.x)
  const satellites: Satellite[] = shown.map((lane, i) => {
    const a = base + SATELLITE_TURNS[i]!
    const reach = 74 + (i >= 2 ? 18 : 0)
    const at = {
      x: clamp(agentsAt.at.x + Math.cos(a) * reach, 40, MAP_W - 40),
      y: clamp(agentsAt.at.y + Math.sin(a) * reach, 30, MAP_H - 22),
    }
    const mine = turn.spans.filter(s => s.lane === lane.id)
    const byCat: Partial<Record<Category, number>> = {}
    for (const s of mine) byCat[s.cat] = (byCat[s.cat] ?? 0) + 1

    return {
      id: lane.id,
      name: lane.name,
      sub: lane.sub,
      at,
      calls: mine.length,
      byCat,
      isRunning: isLive && mine.some(s => s.t1 === undefined),
    }
  })

  // The route: the last few calls of the main loop, model steps left out.
  const path = turn.spans
    .filter(s => s.lane === 'main' && s.cat !== 'model')
    .sort((a, b) => a.t0 - b.t0)
    .slice(-7)
  const route: Leg[] = []
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1]!
    const b = path[i]!
    if (a.cat !== b.cat) route.push({ from: a.cat, to: b.cat, age: nowRel - b.t0 })
  }

  const waitingFrom = isLive
    ? [...new Set(turn.spans.filter(s => s.waitFrom !== undefined && s.waitTo === undefined && s.t1 === undefined).map(s => s.cat))]
    : []

  const main = turn.lanes.find(l => l.id === 'main')

  return {
    len,
    nowRel,
    isLive,
    stations,
    satellites,
    hiddenAgents: subLanes.length - shown.length,
    route,
    waitingFrom,
    totalBusy,
    parallelism: totalBusy / len,
    steps: turn.steps,
    model: main?.sub ?? '',
  }
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

/** The spoke from the hub's rim to a station's rim, bent a little so out and back read apart. */
export function spoke(st: Station): { a: Point; c: Point; b: Point } {
  const a = { x: CX + st.dir.x * (HUB_R + 22), y: CY + st.dir.y * (HUB_R + 22) }
  const b = { x: st.at.x - st.dir.x * (st.r + 4), y: st.at.y - st.dir.y * (st.r + 4) }
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  // Perpendicular, a fixed side, so every spoke curls the same way.
  const c = { x: mid.x - st.dir.y * 16, y: mid.y + st.dir.x * 16 }

  return { a, c, b }
}

/** A point along a quadratic curve, t from 0 to 1. */
export function onCurve(q: { a: Point; c: Point; b: Point }, t: number): Point {
  const u = 1 - t

  return {
    x: u * u * q.a.x + 2 * u * t * q.c.x + t * t * q.b.x,
    y: u * u * q.a.y + 2 * u * t * q.c.y + t * t * q.b.y,
  }
}

/** The inner orbit the route runs along, between the hub's rings and the stations. */
export const ORBIT = 140

/**
 * A leg between two stations as points: in from the first station, round the
 * orbit the short way, out to the second. It never crosses the hub.
 */
export function legPoints(from: Category, to: Category, radius = ORBIT): Point[] {
  const a1 = angleOf(STATIONS.indexOf(from))
  let d = angleOf(STATIONS.indexOf(to)) - a1
  while (d > Math.PI) d -= Math.PI * 2
  while (d <= -Math.PI) d += Math.PI * 2
  const edge = RING - 30
  const at = (a: number, r: number) => ({ x: CX + Math.cos(a) * r, y: CY + Math.sin(a) * r })
  const n = Math.max(2, Math.ceil((Math.abs(d) * radius) / 8))
  const pts = [at(a1, edge)]
  for (let i = 0; i <= n; i += 1) pts.push(at(a1 + (d * i) / n, radius))
  pts.push(at(a1 + d, edge))

  return pts
}

export function pathLength(pts: Point[]): number {
  let n = 0
  for (let i = 1; i < pts.length; i += 1) n += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y)

  return n
}

/** Where an outbound pulse stands now, 0 to 1 along its spoke, for a call running `ms`, the `k`th of `n`. */
export function pulsePhase(ms: number, k: number, n: number): number {
  const offset = n > 1 ? (k / n) * PULSE_MS : 0

  return ((ms + offset) % PULSE_MS) / PULSE_MS
}
