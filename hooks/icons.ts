// One line icon per station, drawn on a 24 × 24 grid and stroked, never filled,
// so the same path reads at full strength on an idle station and as a faint
// watermark under the count once the station has been used.

import type { Category } from '../types'

export const ICONS: Record<Category, string> = {
  // A person: head and shoulders.
  you: 'M12 4.5a3.5 3.5 0 1 1 0 7a3.5 3.5 0 1 1 0-7z M4.5 20c0-4 3.4-6.2 7.5-6.2s7.5 2.2 7.5 6.2',
  // A four-point spark, and a small one beside it.
  model: 'M10 3.5l1.9 5.1 5.1 1.9-5.1 1.9L10 17.5l-1.9-5.1L3 10.5l5.1-1.9z M18 14.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z',
  // A page with a folded corner and two lines of text.
  files: 'M6 3h8l4 4v14H6z M14 3v4h4 M9 12.5h6 M9 16.5h6',
  // A terminal window with a prompt.
  shell: 'M3 5h18v14H3z M7 10l3 2.5L7 15 M12.5 15.5H17',
  // A globe.
  network: 'M12 3a9 9 0 1 1 0 18a9 9 0 1 1 0-18z M3 12h18 M12 3c2.8 2.6 2.8 15.4 0 18 M12 3c-2.8 2.6-2.8 15.4 0 18',
  // A browser window with its tab bar.
  browser: 'M3 5h18v14H3z M3 9h18 M6 7h.01 M8.5 7h.01',
  // Three linked nodes.
  agents: 'M12 3.5a2.5 2.5 0 1 1 0 5a2.5 2.5 0 1 1 0-5z M5 15.5a2.5 2.5 0 1 1 0 5a2.5 2.5 0 1 1 0-5z M19 15.5a2.5 2.5 0 1 1 0 5a2.5 2.5 0 1 1 0-5z M10.8 8.2l-4.6 7.6 M13.2 8.2l4.6 7.6 M7.5 18h9',
  // A stack of discs: a database.
  memory: 'M5 6c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3z M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6 M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3',
  // A wrench.
  tools: 'M14.5 4a5 5 0 0 0-4.3 7.1L4 17.3 6.7 20l6.2-6.2A5 5 0 0 0 20 9.5l-3 3-3.2-.8-.8-3.2z',
  // A hook with its barb.
  hooks: 'M15 3.5a1.5 1.5 0 1 1 0 3a1.5 1.5 0 1 1 0-3z M15 6.5v7.5a5 5 0 0 1-10 0v-1.5 M3 14.5l2-2 2 2',
}

/** A station's icon centred on (x, y), `size` across. */
export function iconSvg(cat: Category, x: number, y: number, size: number, color: string, opacity: number): string {
  const r = (n: number) => (Math.round(n * 10) / 10).toString()
  const k = Math.round((size / 24) * 1000) / 1000

  return `<g transform="translate(${r(x - size / 2)} ${r(y - size / 2)}) scale(${k})" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}"><path d="${ICONS[cat]}"/></g>`
}
