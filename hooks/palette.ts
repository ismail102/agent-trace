// Colours, shared by every drawing: one per category, plus the states.

import type { Category } from '../types'

export const COLORS: Record<Category, string> = {
  you: '#E6E9EF',
  model: '#B794F6',
  memory: '#68D391',
  files: '#63B3ED',
  shell: '#F6AD55',
  network: '#4FD1C5',
  browser: '#A3BFFA',
  agents: '#F6E05E',
  hooks: '#F687B3',
  tools: '#A0AEC0',
}

export const ERR = '#FF6B6B'
export const WAIT = '#FFB020'
export const LIVE = '#5EEAA0'

/** The drawing's ground and lines, dark on every surface: the pane is a dark instrument. */
export const INK = {
  ground: '#11141B',
  well: '#0B0D12',
  line: '#232936',
  faint: '#2C3342',
  text: '#E6E9EF',
  dim: '#8B94A5',
} as const

export const TOKENS = { cache: '#6E5A9E', input: '#B794F6', output: '#F3E8FF' } as const

/** `#RRGGBB` as 0xRRGGBB. */
export function hexToInt(hex: string): number {
  return Number.parseInt(hex.slice(1), 16)
}

/** `a` moved toward `b` by `t` (0 keeps `a`), both 0xRRGGBB. */
export function mix(a: number, b: number, t: number): number {
  const ch = (shift: number) => {
    const x = (a >> shift) & 255
    const y = (b >> shift) & 255

    return Math.round(x + (y - x) * t) & 255
  }

  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}
