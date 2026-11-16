// What a call is (its category) and what of it is kept (its label and input),
// at the privacy tier in force when it started.

import type { Category, Tier } from '../types'

const FILES = new Set([
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'LS',
])
const SHELL = new Set(['Bash', 'PowerShell', 'BashOutput', 'KillShell', 'Monitor'])
const NETWORK = new Set(['WebFetch', 'WebSearch'])
const AGENTS = new Set(['Agent', 'Task', 'SendMessage', 'Workflow'])

/** Claude's own memory: CLAUDE.md, MEMORY.md and anything in a memory folder. */
const MEMORY_PATH = /(^|[\\/])(CLAUDE(\.local)?\.md|MEMORY\.md)$|[\\/]memory[\\/][^\\/]+$/i

function pathOf(args: Args): string | undefined {
  return str(args.file_path) ?? str(args.notebook_path) ?? str(args.path)
}

export function categoryOf(tool: string, args: Args = {}): Category {
  if (FILES.has(tool)) {
    const file = pathOf(args)

    return file && MEMORY_PATH.test(file) ? 'memory' : 'files'
  }
  if (SHELL.has(tool)) return 'shell'
  if (NETWORK.has(tool)) return 'network'
  if (AGENTS.has(tool)) return 'agents'
  const lower = tool.toLowerCase()
  if (lower.startsWith('mcp__') && /memory/.test(lower)) return 'memory'
  if (/browser|chrome|playwright|puppeteer/.test(lower)) return 'browser'
  if (tool === 'AskUserQuestion' || tool === 'ExitPlanMode') return 'you'

  return 'tools'
}

/** A tool's name as people read it: `mcp__server__tool` becomes `server · tool`. */
export function toolName(tool: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(tool)

  return m ? `${m[1]} · ${m[2]}` : tool
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)

  return parts[parts.length - 1] ?? path
}

function hostOf(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#:]+)/i.exec(url)

  return m?.[1] ?? 'a URL'
}

/** The first word of a shell command, the program it runs, with no arguments. */
function programOf(command: string): string {
  const words = command.trim().split(/\s+/)
  // Skip environment assignments (`FOO=1 npm test`) and `sudo`.
  const word = words.find(w => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) && w !== 'sudo')

  return word ? baseName(word) : 'command'
}

type Args = Record<string, unknown>

/**
 * The label drawn on the bar. At the names tier it holds only names: a file's
 * base name, a host, a program. The other tiers use the tool's own description
 * where it gives one.
 */
export function labelOf(tool: string, args: Args, tier: Tier): string {
  const name = toolName(tool)
  const description = str(args.description)

  if (tier !== 'names' && description) return description

  const file = str(args.file_path) ?? str(args.notebook_path) ?? str(args.path)
  if (FILES.has(tool)) return file ? `${name} ${baseName(file)}` : name

  if (SHELL.has(tool)) {
    const command = str(args.command)

    return command ? `${name} · ${programOf(command)}` : name
  }

  if (tool === 'WebFetch') {
    const url = str(args.url)

    return url ? hostOf(url) : name
  }

  if (tool === 'WebSearch') return tier === 'names' ? 'Web search' : `Search: ${str(args.query) ?? ''}`

  if (tool === 'Agent' || tool === 'Task') {
    return `Waiting on ${str(args.subagent_type) ?? 'an agent'}`
  }

  return name
}

const SECRET_KEY = /(token|secret|password|passwd|api[_-]?key|auth|credential|cookie|session[_-]?id)/i
const SECRET_VALUE =
  /(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[abposr]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/

/** One value at the masked tier: secrets hidden, long text replaced by its length. */
function maskValue(key: string, v: unknown): string {
  if (typeof v === 'string') {
    if (SECRET_KEY.test(key) || SECRET_VALUE.test(v)) return '‹hidden›'
    if (v.length > 60 || v.includes('\n')) return `‹${v.length} chars›`

    return JSON.stringify(v)
  }
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v)
  if (Array.isArray(v)) return `‹${v.length} items›`
  if (typeof v === 'object') return `‹object›`

  return '‹?›'
}

const SKIP = new Set(['tool', 'tool_use_id', 'agentId', 'requestMeta', 'consent'])

function argsOnly(e: Args): Args {
  const out: Args = {}
  for (const [k, v] of Object.entries(e)) if (!SKIP.has(k)) out[k] = v

  return out
}

const FULL_LIMIT = 4000

/** The input as kept at a tier. Full input is held in this session's state only. */
export function inputOf(tool: string, e: Args, tier: Tier): string {
  const args = argsOnly(e)
  const name = toolName(tool)

  if (tier === 'names') return `${name} · ${labelOf(tool, args, 'names')}`

  if (tier === 'masked') {
    const parts = Object.entries(args).map(([k, v]) => `${k}: ${maskValue(k, v)}`)

    return `${name}(${parts.join(', ')})`
  }

  let text: string
  if (SHELL.has(tool) && typeof args.command === 'string') {
    text = args.command
  } else {
    try {
      text = JSON.stringify(args, null, 2)
    } catch {
      text = '‹input could not be shown›'
    }
  }
  text = text.replace(new RegExp(SECRET_VALUE.source, 'g'), '‹hidden›')

  return text.length > FULL_LIMIT ? `${text.slice(0, FULL_LIMIT)}\n… ${text.length - FULL_LIMIT} more chars` : text
}

/** A short, safe summary of a result: never the tool's output at the names tier. */
export function resultOf(
  ran: { deny?: string; isError?: boolean; text?: string },
  tier: Tier,
): string {
  if (ran.deny !== undefined) return tier === 'names' ? 'Refused' : `Refused: ${oneLine(ran.deny, 160)}`
  const text = ran.text ?? ''
  const lines = text.length === 0 ? 0 : text.split('\n').length
  const size = `${lines} line${lines === 1 ? '' : 's'} · ${text.length} chars`
  if (ran.isError) return tier === 'names' ? `Failed · ${size}` : `Failed: ${oneLine(text, 200)}`
  if (tier === 'full') return `${size}\n${oneLine(text, 300)}`

  return `Done · ${size}`
}

/** Risk signals a person would want to see before reading anything else. */
export function riskOf(tool: string, args: Args): string | undefined {
  const command = str(args.command)
  if (command) {
    if (/\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r|Remove-Item\b.*-Recurse/i.test(command)) {
      return 'Destructive: recursive delete'
    }
    if (/\bgit\s+push\b.*(--force|-f\b)/.test(command)) return 'Force push'
    if (/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)/.test(command)) return 'Discards local changes'
    if (/\b(curl|wget)\b[^|]*\|\s*(sh|bash)\b/.test(command)) return 'Pipes a download into a shell'
    if (/\bsudo\b/.test(command)) return 'Runs as administrator'
  }
  const file = str(args.file_path)
  if (file && /(^|[\\/])\.env(\.|$)|id_rsa|\.pem$|credentials/i.test(file) && tool !== 'Read') {
    return 'Writes a file that may hold secrets'
  }

  return undefined
}

export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()

  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Programs whose second word names what they do (`git status`, `npm test`), never an argument. */
const SUBCOMMANDS = new Set(['git', 'npm', 'pnpm', 'yarn', 'bun', 'npx', 'docker', 'kubectl', 'cargo', 'go', 'gh', 'claude', 'pip', 'uv', 'poetry', 'make', 'dotnet', 'terraform', 'helm', 'brew', 'apt', 'az', 'aws', 'gcloud'])

/** A shell command as the map says it: the program, and its subcommand where it has one. */
function shellDoing(command: string): string {
  const words = command.trim().split(/\s+/).filter(w => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) && w !== 'sudo')
  const prog = baseName(words[0] ?? 'command')
  const sub = words[1]
  if (sub && SUBCOMMANDS.has(prog.replace(/\.(exe|cmd)$/i, '')) && /^[a-z][a-z0-9:-]{0,20}$/.test(sub)) return `${prog} ${sub}`

  return prog
}

/** The site a call reaches, if it names one. */
export function hostFor(tool: string, args: Args): string | undefined {
  const url = str(args.url)
  if (url && (NETWORK.has(tool) || categoryOf(tool, args) === 'browser')) {
    const host = hostOf(url)

    return host === 'a URL' ? undefined : host.replace(/^www\./, '')
  }

  return undefined
}

/**
 * What the map says a call is doing, short and safe at every tier: a program
 * and its subcommand, a host, a browser action, a memory file's name. Never an
 * argument's value beyond those names.
 */
export function doingOf(tool: string, args: Args): string {
  const cat = categoryOf(tool, args)
  const short = (/^mcp__.+?__(.+)$/.exec(tool)?.[1] ?? tool).replace(/_/g, ' ')

  if (SHELL.has(tool)) {
    const command = str(args.command)
    if (!command) return tool === 'BashOutput' ? 'reading output' : tool === 'KillShell' ? 'stopping a shell' : short
    const what = shellDoing(command)

    return isBackground(args) ? `${what} (background)` : what
  }
  if (tool === 'WebSearch') return 'searching the web'
  if (tool === 'WebFetch') return `fetching ${hostFor(tool, args) ?? 'a page'}`
  if (cat === 'browser') {
    const host = hostFor(tool, args)
    const action = str(args.action)
    const verb = action ? action.replace(/_/g, ' ') : short

    return host ? `${verb} · ${host}` : verb
  }
  if (cat === 'memory') {
    const file = pathOf(args)
    const io = memoryIo(tool)

    return file ? `${io === 'write' ? 'saving' : 'recalling'} ${baseName(file)}` : short
  }
  if (FILES.has(tool)) {
    const file = pathOf(args)

    return file ? `${tool} ${baseName(file)}` : tool
  }
  if (tool === 'Agent' || tool === 'Task') return str(args.subagent_type) ?? 'an agent'

  return toolName(tool)
}

/** Whether a memory call writes or reads. */
export function memoryIo(tool: string): 'read' | 'write' {
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) return 'write'

  return /(write|create|add|update|save|store|set|put|delete|remove|upsert|insert|append|observe)/i.test(tool) ? 'write' : 'read'
}

/** What a memory write puts in, in characters. Reads are sized by their result. */
export function memoryWriteSize(args: Args): number {
  const text = str(args.content) ?? str(args.new_string) ?? str(args.new_source)
  if (text) return text.length
  if (Array.isArray(args.edits)) return args.edits.reduce((n: number, x: unknown) => n + String((x as Args)?.new_string ?? '').length, 0)
  try {
    return JSON.stringify(argsOnly(args)).length
  } catch {
    return 0
  }
}

/** Whether a Bash call was sent to the background. */
export function isBackground(args: Args): boolean {
  return args.run_in_background === true
}
