// The map in a terminal: the same scene as the SVG map, drawn in braille
// dots (two across, four down per cell) and packed as a Raster's cells.
// Each cell takes the colour of the topmost thing drawn in it. Pure.

import type { Turn } from '../types'
import { COLORS, ERR, INK, LIVE, WAIT, hexToInt, mix } from './palette'
import { CX, CY, HUB_R, MAP_H, MAP_W, NAMES, buildScene, ORBIT, legPoints, onCurve, pulsePhase, spoke } from './scene'
import type { Point } from './scene'

/** The terminal's own background and foreground, for cells with nothing in them. */
const DEFAULT = 0x01000000
const GROUND = hexToInt(INK.ground)

const MIN_COLUMNS = 40
const MAX_COLUMNS = 110

/** The Raster's size for a pane, or none where it is too narrow to read. */
export function brailleSize(bodyColumns: number, bodyRows: number): { columns: number; rows: number } | undefined {
  const columns = Math.min(MAX_COLUMNS, bodyColumns)
  if (columns < MIN_COLUMNS) return undefined
  // Dots are about square, so the map keeps its shape at this many rows.
  const natural = Math.round((columns * 2 * MAP_H) / MAP_W / 4)
  const rows = Math.max(10, Math.min(natural, Math.max(10, bodyRows - 8)))

  return { columns, rows }
}

const BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
] as const

class Dots {
  readonly w: number
  readonly h: number
  private on: Uint8Array
  private color: Uint32Array
  private layer: Uint8Array
  private text: (undefined | { ch: number; color: number })[]
  /** Map units to dots: one scale, centred, so circles stay round. */
  private s: number
  private ox: number
  private oy: number

  constructor(
    readonly columns: number,
    readonly rows: number,
  ) {
    this.w = columns * 2
    this.h = rows * 4
    this.on = new Uint8Array(this.w * this.h)
    this.color = new Uint32Array(this.w * this.h)
    this.layer = new Uint8Array(this.w * this.h)
    this.text = new Array(columns * rows)
    this.s = Math.min(this.w / MAP_W, this.h / MAP_H)
    this.ox = (this.w - MAP_W * this.s) / 2
    this.oy = (this.h - MAP_H * this.s) / 2
  }

  /** A point in map units, as dots. */
  at(p: Point): Point {
    return { x: this.ox + p.x * this.s, y: this.oy + p.y * this.s }
  }

  /** A length in map units, as dots. */
  len(n: number): number {
    return n * this.s
  }

  dot(x: number, y: number, color: number, layer: number): void {
    const xi = Math.round(x)
    const yi = Math.round(y)
    if (xi < 0 || yi < 0 || xi >= this.w || yi >= this.h) return
    const i = yi * this.w + xi
    this.on[i] = 1
    if (layer >= this.layer[i]!) {
      this.layer[i] = layer
      this.color[i] = color
    }
  }

  /** A line in map units, sampled at half-dot steps. */
  line(a: Point, b: Point, color: number, layer: number, dash = 0): void {
    const p = this.at(a)
    const q = this.at(b)
    const n = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) * 2))
    for (let i = 0; i <= n; i += 1) {
      if (dash > 0 && Math.floor(i / (dash * 2)) % 2 === 1) continue
      this.dot(p.x + ((q.x - p.x) * i) / n, p.y + ((q.y - p.y) * i) / n, color, layer)
    }
  }

  curve(q: { a: Point; c: Point; b: Point }, color: number, layer: number, dash = 0, from = 0, to = 1): void {
    const steps = 80
    let last: Point | undefined
    for (let i = 0; i <= steps; i += 1) {
      const t = from + ((to - from) * i) / steps
      const p = onCurve(q, t)
      if (last && !(dash > 0 && Math.floor(i / dash) % 2 === 1)) this.line(last, p, color, layer)
      last = p
    }
  }

  ring(c: Point, r: number, color: number, layer: number, a0 = 0, a1 = Math.PI * 2, every = 1): void {
    const p = this.at(c)
    const rr = this.len(r)
    const n = Math.max(12, Math.ceil(rr * 8 * ((a1 - a0) / (Math.PI * 2))))
    for (let i = 0; i <= n; i += 1) {
      if (i % every !== 0) continue
      const a = a0 + ((a1 - a0) * i) / n
      this.dot(p.x + Math.cos(a) * rr, p.y + Math.sin(a) * rr, color, layer)
    }
  }

  /** Connected points in map units. */
  poly(pts: Point[], color: number, layer: number, dash = 0): void {
    for (let i = 1; i < pts.length; i += 1) {
      if (dash > 0 && Math.floor(i / dash) % 2 === 1) continue
      this.line(pts[i - 1]!, pts[i]!, color, layer)
    }
  }

  disc(c: Point, r: number, color: number, layer: number): void {
    const p = this.at(c)
    const rr = Math.max(0.8, this.len(r))
    for (let y = Math.floor(p.y - rr); y <= Math.ceil(p.y + rr); y += 1) {
      for (let x = Math.floor(p.x - rr); x <= Math.ceil(p.x + rr); x += 1) {
        if ((x - p.x) ** 2 + (y - p.y) ** 2 <= rr * rr) this.dot(x, y, color, layer)
      }
    }
  }

  /** Words over the dots, starting at a map point, anchored left, centre or right. */
  label(p: Point, words: string, color: number, anchor: 'start' | 'middle' | 'end' = 'middle'): void {
    const d = this.at(p)
    const row = Math.floor(d.y / 4)
    let col = Math.round(d.x / 2)
    if (anchor === 'middle') col -= Math.floor(words.length / 2)
    if (anchor === 'end') col -= words.length
    col = Math.max(0, Math.min(this.columns - words.length, col))
    if (row < 0 || row >= this.rows) return
    for (let i = 0; i < words.length; i += 1) {
      const ch = words.charCodeAt(i)
      if (col + i >= 0 && col + i < this.columns) this.text[row * this.columns + col + i] = { ch, color }
    }
  }

  /** Every cell, packed as RasterProps' `cells`. */
  pack(): string {
    const bytes = new Uint8Array(this.columns * this.rows * 12)
    const view = new DataView(bytes.buffer)
    for (let row = 0; row < this.rows; row += 1) {
      for (let col = 0; col < this.columns; col += 1) {
        const cell = row * this.columns + col
        const o = cell * 12
        const t = this.text[cell]
        if (t) {
          view.setUint32(o, t.ch, true)
          view.setUint32(o + 4, t.color, true)
          view.setUint32(o + 8, DEFAULT, true)
          continue
        }
        let bits = 0
        let color = DEFAULT
        let top = -1
        for (let dy = 0; dy < 4; dy += 1) {
          for (let dx = 0; dx < 2; dx += 1) {
            const i = (row * 4 + dy) * this.w + col * 2 + dx
            if (!this.on[i]) continue
            bits |= BITS[dy]![dx]!
            if (this.layer[i]! > top) {
              top = this.layer[i]!
              color = this.color[i]!
            }
          }
        }
        view.setUint32(o, bits === 0 ? 0x20 : 0x2800 + bits, true)
        view.setUint32(o + 4, bits === 0 ? DEFAULT : color, true)
        view.setUint32(o + 8, DEFAULT, true)
      }
    }

    return toBase64(bytes)
  }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function toBase64(bytes: Uint8Array): string {
  const out: string[] = []
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    out.push(B64[(n >> 18) & 63]!, B64[(n >> 12) & 63]!, B64[(n >> 6) & 63]!, B64[n & 63]!)
  }
  const left = bytes.length - i
  if (left === 1) {
    const n = bytes[i]! << 16
    out.push(B64[(n >> 18) & 63]!, B64[(n >> 12) & 63]!, '==')
  } else if (left === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8)
    out.push(B64[(n >> 18) & 63]!, B64[(n >> 12) & 63]!, B64[(n >> 6) & 63]!, '=')
  }

  return out.join('')
}

const hex = (c: string) => hexToInt(c)
const dim = (c: string, t: number) => mix(hex(c), GROUND, t)

/** Layers, bottom to top. */
const L = { grid: 1, route: 2, spoke: 3, wait: 4, station: 5, hub: 6, pulse: 7, badge: 8 } as const

/** The map of one turn at this moment, as a Raster's cells. */
export function brailleCells(turn: Turn, now: number, columns: number, rows: number): string {
  const scene = buildScene(turn, now)
  const d = new Dots(columns, rows)
  const center = { x: CX, y: CY }

  // Faint guide ring, dotted.
  d.ring(center, 188, mix(hex(INK.line), GROUND, 0.1), L.grid, 0, Math.PI * 2, 3)

  // Route legs, newest brightest.
  scene.route.forEach((leg, i) => {
    const t = 0.3 + (0.6 * (i + 1)) / scene.route.length
    d.poly(legPoints(leg.from, leg.to, ORBIT - (scene.route.length - 1 - i) * 6), mix(GROUND, hex(INK.text), t * 0.65), L.route)
  })

  // Spokes.
  for (const st of scene.stations) {
    const q = spoke(st)
    if (st.count === 0) continue
    const color = dim(COLORS[st.cat], 0.45 - Math.min(0.35, st.share))
    d.curve(q, color, L.spoke)
    if (st.count >= 4) {
      // A worn spoke is drawn twice, a dot apart.
      const off = { a: { x: q.a.x + 1.6, y: q.a.y + 1.6 }, c: { x: q.c.x + 1.6, y: q.c.y + 1.6 }, b: { x: q.b.x + 1.6, y: q.b.y + 1.6 } }
      d.curve(off, color, L.spoke)
    }
  }

  // Waiting on you.
  for (const cat of scene.waitingFrom) {
    d.poly(legPoints(cat, 'you', ORBIT + 12), hex(WAIT), L.wait, 3)
  }

  // Satellites.
  const agents = scene.stations.find(s => s.cat === 'agents')!
  for (const sat of scene.satellites) {
    d.line(agents.at, sat.at, dim(COLORS.agents, 0.3), L.spoke, sat.isRunning ? 2 : 1)
    d.ring(sat.at, 12, hex(COLORS.agents), L.station)
    d.label({ x: sat.at.x, y: sat.at.y + 26 }, (sat.sub || sat.name).slice(0, 12), hex(INK.dim))
  }

  // Stations: a ring, filled while busy, with its name and count beside it.
  for (const st of scene.stations) {
    const color = st.count > 0 ? hex(COLORS[st.cat]) : dim(INK.faint, 0)
    d.ring(st.at, st.r, color, L.station)
    if (st.running.length > 0) d.disc(st.at, st.r * 0.55, color, L.station)
    if (st.running.length > 0) {
      // The run arc, filling over 30 s.
      const longest = Math.max(...st.running.map(r => r.ms))
      const frac = (longest % 30_000) / 30_000
      d.ring(st.at, st.r + 8, color, L.station, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2)
    }
    if (st.errors > 0) d.disc({ x: st.at.x + st.r * 0.8, y: st.at.y - st.r * 0.8 }, 5, hex(ERR), L.badge)
    if (st.waits > 0) d.disc({ x: st.at.x - st.r * 0.8, y: st.at.y - st.r * 0.8 }, 5, hex(WAIT), L.badge)

    const lx = st.at.x + st.dir.x * (st.r + 18)
    const ly = st.at.y + st.dir.y * (st.r + 18)
    const anchor = Math.abs(st.dir.x) < 0.3 ? 'middle' : st.dir.x > 0 ? 'start' : 'end'
    const words = st.count > 0 ? `${NAMES[st.cat]} ${st.count}${st.errors ? ` !${st.errors}` : ''}` : NAMES[st.cat]
    const y = st.dir.y < -0.6 ? ly - 14 : st.dir.y > 0.6 ? ly + 6 : ly
    d.label({ x: lx, y }, words, st.count > 0 ? hex(COLORS[st.cat]) : hex(INK.dim), anchor)
  }

  // Hub: the share ring, then the clock in words.
  let a = -Math.PI / 2
  for (const st of scene.stations) {
    if (st.share <= 0) continue
    const span = st.share * Math.PI * 2
    d.ring(center, HUB_R + 8, hex(COLORS[st.cat]), L.hub, a, a + span)
    d.ring(center, HUB_R + 11, hex(COLORS[st.cat]), L.hub, a, a + span)
    a += span
  }
  if (scene.totalBusy === 0) d.ring(center, HUB_R + 9, dim(INK.faint, 0), L.hub)
  d.ring(center, HUB_R - 4, scene.isLive ? hex(LIVE) : dim(INK.faint, 0), L.hub)
  d.label({ x: CX, y: CY - 6 }, `${(scene.len / 1000).toFixed(1)}s`, hex(INK.text))
  d.label({ x: CX, y: CY + 14 }, scene.isLive ? 'LIVE' : `${scene.steps} steps`, scene.isLive ? hex(LIVE) : hex(INK.dim))

  // Pulses: out along the spoke while a call runs, back for a moment when it ends.
  for (const st of scene.stations) {
    const q = spoke(st)
    const color = hex(COLORS[st.cat])
    const n = Math.min(st.running.length, 3)
    st.running.slice(0, n).forEach((r, k) => {
      const t = pulsePhase(r.ms, k, n)
      d.disc(onCurve(q, t), 4.5, color, L.pulse)
      d.disc(onCurve(q, Math.max(0, t - 0.08)), 2.6, mix(color, GROUND, 0.4), L.pulse)
    })
    for (const r of st.returning.slice(-3)) {
      const t = 1 - Math.min(1, r.ago / 900)
      if (t <= 0) continue
      d.disc(onCurve(q, t), 4, r.span.status === 'err' ? hex(ERR) : color, L.pulse)
    }
  }

  // Corner: parallelism and the busiest station.
  d.label({ x: 6, y: 18 }, `${scene.parallelism.toFixed(1)}× parallel`, hex(INK.dim), 'start')
  if (scene.waitingFrom.length > 0) d.label({ x: CX, y: 28 }, 'NEEDS YOU', hex(WAIT))


  return d.pack()
}
