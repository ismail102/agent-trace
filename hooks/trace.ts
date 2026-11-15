// Pure changes to the trace: each takes a Trace and returns a new one.

import type { Lane, Span, Trace, Turn } from '../types'

export const EMPTY: Trace = { turns: [], activeTurnId: null }

/** Spans kept per turn; the oldest leave first. */
const MAX_SPANS = 500

export const MAIN_LANES: Lane[] = [
  { id: 'events', name: 'Events', sub: 'hooks · approvals · answer' },
  { id: 'main', name: 'Main loop', sub: '' },
]

export const BG_LANE: Lane = { id: 'bg', name: 'Background', sub: 'background shells' }

export function startTurn(trace: Trace, id: string, now: number, keep: number): Trace {
  const turn: Turn = {
    id,
    startedAt: now,
    lanes: MAIN_LANES.map(l => ({ ...l })),
    spans: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    steps: 0,
    tools: 0,
    errors: 0,
    waitedMs: 0,
  }
  // A turn left open (an engine restart, a lost end) is closed where it stood.
  const closed = trace.turns.map(t => (t.endedMs === undefined ? closeTurn(t, now, 'unknown') : t))

  return { turns: [...closed, turn].slice(-Math.max(1, keep)), activeTurnId: id }
}

/** The turn new work belongs to: the running one, else the newest. */
export function activeTurn(trace: Trace): Turn | undefined {
  return trace.turns.find(t => t.id === trace.activeTurnId) ?? trace.turns[trace.turns.length - 1]
}

export function mapActive(trace: Trace, fn: (turn: Turn) => Turn): Trace {
  const turn = activeTurn(trace)
  if (!turn) return trace

  return { ...trace, turns: trace.turns.map(t => (t.id === turn.id ? fn(t) : t)) }
}

export function ensureLane(turn: Turn, lane: Lane): Turn {
  const at = turn.lanes.findIndex(l => l.id === lane.id)
  if (at === -1) {
    // Background stays last.
    const lanes = [...turn.lanes.filter(l => l.id !== 'bg'), lane, ...turn.lanes.filter(l => l.id === 'bg')]

    return { ...turn, lanes }
  }
  const old = turn.lanes[at]
  // A subagent's type learned later (SubagentStart) fills in its subtitle.
  if (old !== undefined && lane.sub !== '' && lane.sub !== old.sub) {
    return { ...turn, lanes: turn.lanes.map((l, i) => (i === at ? { ...l, sub: lane.sub } : l)) }
  }

  return turn
}

export function addSpan(turn: Turn, span: Span): Turn {
  const spans = [...turn.spans.filter(s => s.id !== span.id), span]

  return { ...turn, spans: spans.length > MAX_SPANS ? spans.slice(-MAX_SPANS) : spans }
}

export function patchSpan(turn: Turn, id: string, patch: Partial<Span>): Turn {
  return { ...turn, spans: turn.spans.map(s => (s.id === id ? { ...s, ...patch } : s)) }
}

/** The newest still-running span that matches, for events that carry no call id. */
export function findOpen(turn: Turn, test: (s: Span) => boolean): Span | undefined {
  for (let i = turn.spans.length - 1; i >= 0; i -= 1) {
    const s = turn.spans[i]
    if (s !== undefined && s.t1 === undefined && test(s)) return s
  }

  return undefined
}

export function closeTurn(turn: Turn, now: number, reason: string): Turn {
  const endedMs = Math.max(0, now - turn.startedAt)
  // Anything left running ends with the turn, except background work.
  const spans = turn.spans.map(s =>
    s.t1 === undefined && s.lane !== 'bg' ? { ...s, t1: endedMs, status: s.status === 'run' ? ('ok' as const) : s.status } : s,
  )

  return { ...turn, spans, endedMs, reason }
}

/** The turn's end, or now while it runs. */
export function turnLength(turn: Turn, now: number): number {
  return turn.endedMs ?? Math.max(0, now - turn.startedAt)
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)

  return `${m} m ${s} s`
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`

  return `${(n / 1_000_000).toFixed(2)}M`
}
