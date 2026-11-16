// agent-trace: a live swimlane trace of each turn, in a pane beside the chat.
//
// It listens and never changes what it hears: every hook passes the event on
// with `next(e)` untouched and records what it saw around that call.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Category, Filter, Mode, Span, Tier, Trace, Turn, View } from '../types'
import { categoryOf, doingOf, hostFor, inputOf, isBackground, labelOf, memoryIo, memoryWriteSize, oneLine, resultOf, riskOf } from './capture'
import { brailleCells, brailleSize } from './braille'
import { MAP_KEY, drawPane } from './draw'
import { BG_LANE, EMPTY, activeTurn, addSpan, closeTurn, ensureLane, findOpen, mapActive, patchSpan, startTurn } from './trace'

const PANE = 'agent-trace'
const TITLE = 'Agent Trace'
const TIER_KEY = 'tier'
const MODE_KEY = 'mode'
/** How often the terminal map repaints its pulses while a turn runs. */
const FRAME_MS = 200

// Change a tag when the shape of what it holds changes: a reload keeps
// $.state, and the tag makes the new code start from `initial` instead.
const trace = atom({ plugin: 'agent-trace', key: 'trace' } as const, EMPTY, { shape: 'trace-1' })
const view = atom(
  { plugin: 'agent-trace', key: 'view' } as const,
  { tier: 'names', filter: 'all', sel: null, back: 0, mode: 'map' } as View,
  { shape: 'view-1' },
)
const tick = atom({ plugin: 'agent-trace', key: 'tick' } as const, 0)

const TIERS: Tier[] = ['names', 'masked', 'full']

const MODES: Mode[] = ['map', 'timeline', 'insights']

function asMode(value: unknown): Mode | undefined {
  return MODES.includes(value as Mode) ? (value as Mode) : undefined
}

function asTier(value: unknown): Tier | undefined {
  return TIERS.includes(value as Tier) ? (value as Tier) : undefined
}

/** The terminal map on show, if any: what the frame loop repaints. A reload starts afresh. */
const painter: { size: { columns: number; rows: number } | undefined; isPainting: boolean } = { size: undefined, isPainting: false }

/** One frame of the terminal map, repainted in place while the live turn is on show. */
async function frame($: EngineInterface): Promise<void> {
  const size = painter.size
  if (size === undefined || painter.isPainting) return
  const t = await read($, trace)
  if (t.activeTurnId === null) return
  const v = await read($, view)
  // Only the live turn moves.
  if (v.back !== 0 || (v.mode ?? 'map') !== 'map') return
  const turn = t.turns.find(x => x.id === t.activeTurnId)
  if (!turn) return
  painter.isPainting = true
  try {
    const now = await $.clock.now()
    const cells = brailleCells(turn, now, size.columns, size.rows)
    const sent = await $.ui.blit({ requestId: PANE, key: MAP_KEY, cells, columns: size.columns, rows: size.rows })
    // Refused: closed, behind another pane, or resized. The next drawing starts it again.
    if (sent.deny !== undefined && painter.size === size) painter.size = undefined
  } catch {
    painter.size = undefined
  } finally {
    painter.isPainting = false
  }
}

/** Ms since the turn started. */
function rel(turn: Turn, now: number): number {
  return Math.max(0, now - turn.startedAt)
}

/** A subagent's lane: named by the order agents appeared in this turn. */
function agentLane(turn: Turn, agentId: string, type = ''): Turn {
  const known = turn.lanes.find(l => l.id === agentId)
  if (known) return ensureLane(turn, { ...known, sub: type })
  const count = turn.lanes.filter(l => !['events', 'main', 'bg'].includes(l.id)).length
  const letter = count < 26 ? String.fromCharCode(65 + count) : String(count + 1)

  return ensureLane(turn, { id: agentId, name: `Agent ${letter}`, sub: type })
}

function laneOf(agentId: string | undefined): string {
  return agentId ?? 'main'
}

function parentOf(turn: Turn, lane: string): string {
  const name = turn.lanes.find(l => l.id === lane)?.name ?? lane
  const step = turn.spans.filter(s => s.lane === lane && s.cat === 'model').length

  return step > 0 ? `${name} · step ${step}` : name
}

/** A point-in-time marker on the Events lane. */
function marker(id: string, cat: Category, label: string, at: number, extra: Partial<Span> = {}): Span {
  return { id, lane: 'events', cat, label, t0: at, t1: at, status: 'ok', tier: 'names', ...extra }
}

export const register: Register = (on, options) => {
  const keep = typeof options.keepTurns === 'number' ? Math.max(1, Math.min(50, options.keepTurns)) : 10
  const autoOpen = options.autoOpen !== false
  // Hook timing below this is noise: the classic events fire whether or not
  // a settings hook is configured.
  const hookFloorMs = 40
  let hookCount = 0

  // ---- session --------------------------------------------------------------

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'agent-trace',
      description: 'Show the live trace of tool calls, model steps, subagents, hooks and permission waits',
      argumentHint: '[clear]',
    })

    // The tier: the pane's last choice, else the plugin setting.
    const stored = asTier(await $.store.get(TIER_KEY))
    const tier = stored ?? asTier(options.detail) ?? 'names'
    const mode = asMode(await $.store.get(MODE_KEY)) ?? 'map'
    await update($, view, v => ({ ...v, tier, mode }))

    // Open bars grow while a turn runs: one write a second, nothing when idle.
    $.clock.every(1000, () => {
      void (async () => {
        const t = await read($, trace)
        if (t.activeTurnId !== null) await update($, tick, () => Date.now())
      })()
    })

    // Between those redraws the terminal's map moves on its own: its pulses
    // are repainted in place, a few times a second, while a turn runs.
    $.clock.every(FRAME_MS, () => {
      void frame($)
    })

    if (autoOpen) void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('command.run', { command: 'agent-trace' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      await update($, trace, () => EMPTY)
      await update($, view, v => ({ ...v, sel: null, back: 0 }))

      return { text: 'Agent Trace cleared.' }
    }
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Agent Trace pane opened.' }
  })

  // ---- turns and model steps -----------------------------------------------

  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    if (e.agentId === undefined) {
      await update($, trace, t => startTurn(t, e.turnId, now, keep))
      await update($, view, v => ({ ...v, sel: null, back: 0 }))
    } else {
      const agentId = e.agentId
      await update($, trace, t => mapActive(t, turn => agentLane(turn, agentId)))
    }

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const now = await $.clock.now()
    const lane = laneOf(e.agentId)
    const id = `step:${e.turnId}:${e.index}:${lane}`
    const tier = (await read($, view)).tier
    await update($, trace, t =>
      mapActive(t, turn => {
        const withLane = e.agentId ? agentLane(turn, e.agentId) : turn
        const label = `step ${withLane.spans.filter(s => s.lane === lane && s.cat === 'model').length + 1}`
        const main = withLane.lanes.find(l => l.id === 'main')
        const lanes =
          lane === 'main' && main && main.sub === ''
            ? withLane.lanes.map(l => (l.id === 'main' ? { ...l, sub: e.model } : l))
            : withLane.lanes

        return addSpan(
          { ...withLane, lanes, steps: withLane.steps + 1 },
          {
            id,
            lane,
            cat: 'model',
            label,
            t0: rel(withLane, now),
            status: 'run',
            parent: e.index === 0 ? (lane === 'main' ? 'Your message' : 'Its spawn') : parentOf(withLane, lane),
            input: `Model request · ${e.model}${e.effort !== undefined ? ` · effort ${e.effort}` : ''} · ${e.messageCount} messages`,
            tier,
            model: e.model,
          },
        )
      }),
    )

    const response = yield* next(e)

    const done = await $.clock.now()
    const u = response.usage
    const tools = response.toolUses.map(t => t.name)
    await update($, trace, t =>
      mapActive(t, turn => {
        const usage = u
          ? {
              input: turn.usage.input + u.input_tokens,
              output: turn.usage.output + u.output_tokens,
              cacheRead: turn.usage.cacheRead + (u.cache_read_input_tokens ?? 0),
              cacheWrite: turn.usage.cacheWrite + (u.cache_creation_input_tokens ?? 0),
            }
          : turn.usage
        const failed = response.stopReason === null && u === null

        return patchSpan({ ...turn, usage }, id, {
          t1: rel(turn, done),
          status: failed ? 'err' : 'ok',
          tokens: u
            ? `${u.input_tokens} in · ${u.output_tokens} out · ${u.cache_read_input_tokens ?? 0} from cache`
            : undefined,
          tokIn: u ? u.input_tokens + (u.cache_creation_input_tokens ?? 0) : undefined,
          tokCache: u ? (u.cache_read_input_tokens ?? 0) : undefined,
          tokOut: u ? u.output_tokens : undefined,
          result: failed
            ? 'No response (the request failed or was interrupted)'
            : tools.length > 0
              ? `Asked for ${tools.length} tool call${tools.length === 1 ? '' : 's'}: ${tools.slice(0, 6).join(', ')}${tools.length > 6 ? '…' : ''}`
              : tier === 'names'
                ? `Answered · ${response.answer.length} chars`
                : `Answered: ${oneLine(response.answer, 200)}`,
        })
      }),
    )

    return response
  })

  on('turn.complete', async ($, e, next) => {
    const now = await $.clock.now()
    if (e.agentId === undefined) {
      await update($, trace, t => {
        const turn = t.turns.find(x => x.id === e.turnId) ?? activeTurn(t)
        if (!turn) return t
        const at = rel(turn, now)
        const label = e.reason === 'answer' ? 'Answer ready' : e.reason === 'aborted' ? 'Interrupted' : e.reason === 'refusal' ? 'Refused' : 'Ended on an error'
        const closed = closeTurn(
          addSpan(turn, marker(`end:${turn.id}`, 'you', label, at, { status: e.reason === 'error' ? 'err' : 'ok', result: `Turn finished in ${(e.durationMs / 1000).toFixed(1)} s` })),
          now,
          e.reason,
        )

        return { turns: t.turns.map(x => (x.id === turn.id ? closed : x)), activeTurnId: null }
      })
    } else {
      const agentId = e.agentId
      await update($, trace, t =>
        mapActive(t, turn => {
          const name = turn.lanes.find(l => l.id === agentId)?.name ?? 'Agent'

          return addSpan(turn, marker(`agent-end:${e.turnId}`, 'agents', `${name} done`, rel(turn, now)))
        }),
      )
    }

    return next(e)
  })

  // ---- tool calls ----------------------------------------------------------

  on('tool.call', async ($, e, next) => {
    const now = await $.clock.now()
    const tool = String(e.tool)
    const args = e as unknown as Record<string, unknown>
    const tier = (await read($, view)).tier
    const isBg = isBackground(args) && e.agentId === undefined
    const lane = isBg ? 'bg' : laneOf(e.agentId)
    const id = e.tool_use_id || `call:${now}:${tool}`
    const cat = categoryOf(tool, args)
    const io = cat === 'memory' ? memoryIo(tool) : undefined

    await update($, trace, t =>
      mapActive(t, turn => {
        let withLanes = turn
        if (isBg) withLanes = ensureLane(withLanes, BG_LANE)
        if (e.agentId) withLanes = agentLane(withLanes, e.agentId)

        return addSpan(
          { ...withLanes, tools: withLanes.tools + 1 },
          {
            id,
            lane,
            cat,
            label: labelOf(tool, args, tier),
            t0: rel(withLanes, now),
            status: 'run',
            parent: parentOf(withLanes, e.agentId ?? 'main'),
            input: inputOf(tool, args, tier),
            tier,
            risk: riskOf(tool, args),
            tool,
            // Names only: names. Above that, the call's own description where it gives one.
            doing: tier !== 'names' && typeof args.description === 'string' && args.description.trim() !== '' ? oneLine(args.description, 60) : doingOf(tool, args),
            host: hostFor(tool, args),
            io,
            bytes: io === 'write' ? memoryWriteSize(args) : undefined,
          },
        )
      }),
    )

    const ran = await next(e)

    const done = await $.clock.now()
    await update($, trace, t =>
      mapActive(t, turn => {
        const span = turn.spans.find(s => s.id === id)
        if (!span) return turn
        const at = rel(turn, done)
        const failed = ran.deny !== undefined || ran.isError === true
        let waitTo = span.waitTo
        if (span.waitFrom !== undefined && waitTo === undefined) {
          waitTo = span.execMs !== undefined ? Math.max(span.waitFrom, at - span.execMs) : at
        }
        const waited = span.waitFrom !== undefined && waitTo !== undefined ? waitTo - span.waitFrom : 0
        const deniedByYou = span.waitFrom !== undefined && span.execMs === undefined && failed
        const status = deniedByYou || (span.waitFrom !== undefined && !failed) ? 'wait' : failed ? 'err' : 'ok'
        const result = deniedByYou ? `Denied by you after ${(waited / 1000).toFixed(1)} s` : resultOf(ran, span.tier)
        // A background shell keeps running after its call returns.
        const stillRunning = span.lane === 'bg' && !failed
        let patched = patchSpan(turn, id, {
          t1: stillRunning ? undefined : at,
          status: stillRunning ? 'run' : status,
          waitTo,
          result: stillRunning ? 'Started in the background · still running' : result,
          // A memory read is sized by what came back.
          ...(span.io === 'read' && !failed ? { bytes: (ran.text ?? '').length } : {}),
        })
        if (span.waitFrom !== undefined && waitTo !== undefined) {
          patched = addSpan(
            patched,
            marker(`answer:${id}`, 'you', deniedByYou ? 'Denied by you' : 'Approved by you', waitTo, {
              parent: 'You',
              result: `${span.label}: ${deniedByYou ? 'denied' : 'approved'}`,
            }),
          )
        }

        return {
          ...patched,
          errors: patched.errors + (status === 'err' ? 1 : 0),
          waitedMs: patched.waitedMs + waited,
        }
      }),
    )

    return ran
  })

  // ---- classic events: permission prompts, subagents, hooks ---------------

  on('classic.PermissionRequest', async ($, e, next) => {
    const now = await $.clock.now()
    const lane = laneOf(e.agent_id)
    await update($, trace, t =>
      mapActive(t, turn => {
        const span = findOpen(turn, s => s.tool === e.tool_name && s.waitFrom === undefined && (s.lane === lane || s.lane === 'bg'))
        if (!span) return turn
        const at = rel(turn, now)

        return addSpan(
          patchSpan(turn, span.id, { waitFrom: at }),
          marker(`ask:${span.id}`, 'hooks', 'Permission asked', at, { parent: span.label, result: `Asked you about ${span.label}` }),
        )
      }),
    )

    return next(e)
  })

  on('classic.PermissionDenied', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, trace, t =>
      mapActive(t, turn =>
        addSpan(
          patchSpan(turn, e.tool_use_id, { result: 'Denied by the permission check' }),
          marker(`denied:${e.tool_use_id}`, 'hooks', 'Denied (auto)', rel(turn, now), { status: 'err', result: e.reason }),
        ),
      ),
    )

    return next(e)
  })

  on('classic.PostToolUse', async ($, e, next) => {
    const ms = e.duration_ms
    if (typeof ms === 'number') {
      await update($, trace, t => mapActive(t, turn => patchSpan(turn, e.tool_use_id, { execMs: ms })))
    }

    return next(e)
  })

  on('classic.PostToolUseFailure', async ($, e, next) => {
    const ms = e.duration_ms
    if (typeof ms === 'number') {
      await update($, trace, t => mapActive(t, turn => patchSpan(turn, e.tool_use_id, { execMs: ms })))
    }

    return next(e)
  })

  on('classic.SubagentStart', async ($, e, next) => {
    await update($, trace, t => mapActive(t, turn => agentLane(turn, e.agent_id, e.agent_type)))

    return next(e)
  })

  // Any settings hook that takes real time or decides something gets a bar.
  on('classic.*', async ($, e, next) => {
    const started = await $.clock.now()
    const r = (await next(e)) as Record<string, unknown> | undefined
    const done = await $.clock.now()
    const took = done - started
    const decided = r !== undefined && (r.block !== undefined || r.preventContinuation === true || r.decision !== undefined)
    if (took < hookFloorMs && !decided) return r

    const ev = e as unknown as Record<string, unknown>
    const name = typeof ev.hook_event_name === 'string' ? ev.hook_event_name : 'PreToolUse'
    hookCount += 1
    const n = hookCount
    await update($, trace, t =>
      mapActive(t, turn =>
        addSpan(turn, {
          id: `hook:${done}:${n}`,
          lane: 'events',
          cat: 'hooks',
          label: `${name} hook`,
          t0: rel(turn, started),
          t1: rel(turn, done),
          status: r !== undefined && r.block !== undefined ? 'err' : 'ok',
          parent: `${name} settings hooks`,
          tier: 'names',
          result: decided ? `Decided: ${oneLine(JSON.stringify(r), 160)}` : `Ran for ${took} ms`,
        }),
      ),
    )

    return r
  })

  // ---- the pane ------------------------------------------------------------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const t = await read($, trace)
    const v = await read($, view)
    if (t.activeTurnId !== null) await read($, tick)
    const now = await $.clock.now()
    const surface = e.surface

    const setView = (fn: (old: View) => View) => void update($, view, fn)
    const columns = e.props.bodyColumns
    const rows = e.props.scroll.bodyRows

    // Remember the terminal map this drawing puts up, for the frame loop.
    const showsMap = surface === 'terminal' && (v.mode ?? 'map') === 'map' && t.turns.length > 0
    painter.size = showsMap ? brailleSize(columns, rows) : undefined

    return drawPane(els, surface, t.turns, v, now, columns, rows, {
      setTier: (tier: Tier) => {
        setView(old => ({ ...old, tier }))
        void $.store.set(TIER_KEY, tier)
      },
      setMode: (mode: Mode) => {
        setView(old => ({ ...old, mode }))
        void $.store.set(MODE_KEY, mode)
      },
      setFilter: (filter: Filter) => setView(old => ({ ...old, filter, sel: null })),
      select: (id: string) => setView(old => ({ ...old, sel: id })),
      older: () => setView(old => ({ ...old, back: old.back + 1, sel: null })),
      newer: () => setView(old => ({ ...old, back: Math.max(0, old.back - 1), sel: null })),
      copy: (span: Span) => void $.ui.copy({ text: JSON.stringify(span, null, 2), surface }),
      clear: () => {
        void update($, trace, (): Trace => EMPTY)
        setView(old => ({ ...old, sel: null, back: 0 }))
      },
    })
  })
}
