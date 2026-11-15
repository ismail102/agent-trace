import { expect, mock, test } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

const PANE = {
  plugin: 'agent-trace',
  component: 'Pane',
  requestId: 'agent-trace',
  props: {
    title: 'Agent Trace',
    isFocused: false,
    bodyColumns: 90,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(r => {
    resolve = r
  })

  return { promise, resolve }
}

const USAGE = {
  input_tokens: 1200,
  output_tokens: 80,
  cache_read_input_tokens: 900,
  cache_creation_input_tokens: 0,
  model: 'opus',
}

/** Engine stand-ins for everything the plugin passes on. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function engine(on: any) {
  on('command.register', () => ({ value: { command: 'agent-trace' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
  on('turn.step', async function* (_: unknown, e: { turnId: string; index: number }) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: USAGE }
  })
  on('classic.PermissionRequest', () => ({}))
  on('classic.SubagentStart', () => ({}))
  on('classic.PostToolUse', () => ({}))
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function step($: any, turnId: string, index: number, agentId?: string) {
  const s = $.turn.step({ turnId, index, model: 'opus', messageCount: 3, ...(agentId ? { agentId } : {}) })
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _ of s) {
    // drain
  }

  return s.result
}

test('a turn is traced: steps, a failed call, a permission wait, the summary', async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)

  // The failing test run takes 1.5 s; the delete waits on a permission answer.
  const answer = deferred<unknown>()
  on('tool.call', async (_, e) => {
    if (e.tool === 'Bash' && e.command === 'npm test') {
      await clock.advance(1500)

      return { result: 'FAIL', isError: true, text: 'FAIL tests/session.test.ts' }
    }

    return answer.promise
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'fix the cookie bug', turnId: 't1' })
  await step($, 't1', 0)
  await $.tool.call({ tool: 'Bash', command: 'npm test' })

  const rm = $.tool.call({ tool: 'Bash', command: 'rm -rf build/' })
  await clock.advance(100)
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm -rf build/' } })
  await clock.advance(2900)
  answer.resolve({ result: undefined, isError: true, text: 'The user denied this.' })
  await rm

  await step($, 't1', 1)
  await $.turn.complete({ answer: 'done', durationMs: 5000, isAborted: false, turnId: 't1', reason: 'answer' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect((await ui.find({ type: 'Text', text: /Turn 1 of 1/ }))?.text).toContain('Turn 1 of 1')
    expect(await ui.find({ type: 'Text', text: /^2$/ })).toBeDefined()

    // The map: stations with their counts, as chips that filter the list.
    await ui.press({ key: 'm-map' })
    expect(await ui.find({ type: 'Button', text: /^Shell 2$/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /^Errors 1$/ })).toBeDefined()
    if (surface === 'terminal') {
      const raster = await ui.find({ type: 'Raster' })
      expect(raster?.props.columns).toBe(90)
    } else {
      const map = await ui.find({ type: 'Svg' })
      expect(String(map?.props.source)).toContain('PARALLELISM')
      expect(String(map?.props.alt)).toMatch(/Shell 2/)
    }

    // The timeline: lanes, with what was in flight above them.
    await ui.press({ key: 'm-timeline' })
    if (surface === 'terminal') {
      expect(await ui.find({ type: 'Text', text: /Main loop/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /in flight/ })).toBeDefined()
    } else {
      const tl = await ui.find({ type: 'Svg' })
      expect(String(tl?.props.source)).toContain('IN FLIGHT')
      expect(String(tl?.props.source)).toContain('Main loop')
    }

    // Insights: where the time went, tokens per step.
    await ui.press({ key: 'm-insights' })
    if (surface === 'terminal') {
      expect(await ui.find({ type: 'Text', text: /Where the time went/ })).toBeDefined()
    } else {
      const ins = await ui.find({ type: 'Svg' })
      expect(String(ins?.props.source)).toContain('WHERE THE TIME WENT')
      expect(String(ins?.props.source)).toContain('900 from cache')
    }

    // The delete waited on the person and was denied.
    const rmRow = await ui.find({ type: 'Button', text: /Bash · rm/ })
    expect(rmRow).toBeDefined()
    await ui.press({ key: rmRow!.key! })
    expect(await ui.find({ type: 'Text', text: /Denied by you after 2\.9 s/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Destructive: recursive delete/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Waited on you 2\.9 s/ })).toBeDefined()

    // The failed test run counts as the turn's one error.
    const testRow = await ui.find({ type: 'Button', text: /Bash · npm/ })
    await ui.press({ key: testRow!.key! })
    expect(await ui.find({ type: 'Text', text: /\[Failed\]/ })).toBeDefined()

    await ui.unmount()
  }
})

test('the live map pulses, asks for you, and repaints the terminal between redraws', async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: 5_000_000 })
  mock.store(on)
  const blits: { key: string }[] = []
  on('ui.blit', (_, e) => {
    blits.push({ key: e.key })

    return { value: {} }
  })
  const done = deferred<unknown>()
  on('tool.call', () => done.promise)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'build it', turnId: 't1' })
  await step($, 't1', 0)
  const call = $.tool.call({ tool: 'Bash', command: 'npm run build' })
  await clock.advance(700)

  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  let map = String((await ui.find({ type: 'Svg' }))?.props.source)
  expect(map).toContain('animateMotion')
  expect(map).toContain('LIVE')
  expect(map).not.toContain('NEEDS YOU')
  await ui.unmount()

  // A permission prompt: the map draws the call's station reaching for You.
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'npm run build' } })
  await clock.advance(300)
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  map = String((await ui.find({ type: 'Svg' }))?.props.source)
  expect(map).toContain('NEEDS YOU')
  await ui.unmount()

  // The terminal's braille map moves between redraws.
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Raster' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Waiting on you: Shell/ })).toBeDefined()
  const before = blits.length
  await clock.advance(1000)
  expect(blits.length).toBeGreaterThan(before)
  expect(blits[blits.length - 1]?.key).toBe('map')
  await ui.unmount()

  done.resolve({ result: 'ok', text: 'built' })
  await call
})

test('names-only keeps no arguments; masked hides secrets', async ($, on) => {
  engine(on)
  mock.clock(on, { now: 2_000_000 })
  mock.store(on)
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))

  const secret = 'sk-ant-abcdefghijklmnopqrstuvwxyz0123'
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: `curl -H "x-api: ${secret}" https://example.com` })

  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  let row = await ui.find({ type: 'Button', text: /Bash · curl/ })
  await ui.press({ key: row!.key! })
  expect(await ui.find({ type: 'Text', text: /example\.com/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /sk-ant/ })).toBeUndefined()

  // Switch to masked: only calls from now on are captured that way.
  await ui.press({ key: 't-masked' })
  await ui.unmount()
  await $.tool.call({ tool: 'Bash', command: `curl -H "x-api: ${secret}" x`, description: 'Fetch the page' })

  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  row = await ui.find({ type: 'Button', text: /Fetch the page/ })
  await ui.press({ key: row!.key! })
  expect(await ui.find({ type: 'Text', text: /‹hidden›/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /sk-ant/ })).toBeUndefined()
  await ui.unmount()
})

test('a subagent gets a lane of its own, named by its type', async ($, on) => {
  engine(on)
  mock.clock(on, { now: 3_000_000 })
  mock.store(on)
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'look around', turnId: 't1' })
  await $.turn.start({ text: 'find the tests', turnId: 'a-t1', agentId: 'a1' })
  await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'Explore' })
  await step($, 'a-t1', 0, 'a1')
  await $.tool.call({ tool: 'Grep', pattern: 'token.exp', agentId: 'a1' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Agent A/ })).toBeDefined()
  const row = await ui.find({ type: 'Button', text: /Grep/ })
  await ui.press({ key: row!.key! })
  expect(await ui.find({ type: 'Text', text: /Agent A/ })).toBeDefined()
  await ui.unmount()
})

test('an empty trace says how to start', async ($, on) => {
  engine(on)
  mock.clock(on, { now: 4_000_000 })
  mock.store(on)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /No turns yet/ })).toBeDefined()
    await ui.unmount()
  }
})
