// The values agent-trace keeps in $.state, and the shapes they hold.

/** What a span is: the colour and the filter it belongs to. */
export type Category =
  | 'you'
  | 'model'
  | 'memory'
  | 'files'
  | 'shell'
  | 'network'
  | 'browser'
  | 'agents'
  | 'hooks'
  | 'tools'

/** ok: finished; err: failed or refused; wait: waited on the person; run: still going. */
export type SpanStatus = 'ok' | 'err' | 'wait' | 'run'

/** How much of a call's input is captured: chosen in the pane or the plugin's settings. */
export type Tier = 'names' | 'masked' | 'full'

export type Span = {
  id: string
  /** 'events', 'main', 'bg' or a subagent's id. */
  lane: string
  cat: Category
  /** The short label drawn on the bar. */
  label: string
  /** Milliseconds since the turn started. */
  t0: number
  /** Milliseconds since the turn started; absent while it runs. */
  t1?: number
  status: SpanStatus
  /** A permission prompt inside this span, ms since the turn started. */
  waitFrom?: number
  waitTo?: number
  /** Tool execution time reported by PostToolUse, used to end the wait. */
  execMs?: number
  /** What issued it: a lane and step, a hook, the person. */
  parent?: string
  /** The input, captured at the tier in force when it started. */
  input?: string
  tier: Tier
  result?: string
  tokens?: string
  /** A model step's token counts, for the Insights charts. */
  tokIn?: number
  tokOut?: number
  tokCache?: number
  risk?: string
  tool?: string
  /** The model a step ran on. */
  model?: string
  /** A memory call's size in characters: what it wrote, or what it read back. */
  bytes?: number
  /** Whether a memory call read or wrote. */
  io?: 'read' | 'write'
  /** What the map says the call is doing, kept at the names tier: a program, a host, a browser action. */
  doing?: string
  /** The site a network or browser call went to. */
  host?: string
}

export type Lane = { id: string; name: string; sub: string }

export type TurnUsage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type Turn = {
  id: string
  /** Epoch ms. */
  startedAt: number
  /** Ms since the start; absent while the turn runs. */
  endedMs?: number
  reason?: string
  lanes: Lane[]
  spans: Span[]
  usage: TurnUsage
  steps: number
  tools: number
  errors: number
  waitedMs: number
}

export type Trace = {
  turns: Turn[]
  activeTurnId: string | null
}

export type Filter =
  | 'all'
  | 'model'
  | 'files'
  | 'shell'
  | 'network'
  | 'agents'
  | 'hooks'
  | 'memory'
  | 'browser'
  | 'tools'
  | 'you'
  | 'err'

/** What the pane draws above the span list. */
export type Mode = 'map' | 'timeline' | 'insights'

export type View = {
  tier: Tier
  filter: Filter
  /** The selected span's id, or null for the newest. */
  sel: string | null
  /** 0 is the newest turn, 1 the one before, and so on. */
  back: number
  /** Map, timeline or insights; absent (a view kept from 0.1.0) reads as map. */
  mode?: Mode
}

declare module 'claude-code' {
  interface PluginState {
    'agent-trace': {
      trace: Shaped<Trace>
      view: Shaped<View>
      /** Epoch ms, written once a second while a turn runs so open bars grow. */
      tick: number
    }
  }
}
