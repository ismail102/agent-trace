# Changelog

## 0.2.0

- A new **Map** view, the default: the main loop as a hub with a station for each kind of work. Running calls pulse out along spokes and comets run back when they end. Spokes wear in with use. Stations carry run arcs, failure and wait badges, and a marching amber line to You while a call waits on you. The route runs round an inner orbit. Subagents are satellites with their own call mix. The hub has rings for where the time went and for tokens, and the map shows parallelism and cache-hit read-outs.
- In the terminal, the map is drawn in coloured braille on a `Raster` and repainted in place five times a second while the live turn is on show.
- A new **Insights** view: time by kind of work, tokens per model step (input over output), the slowest calls with their waits hatched, and recent turns side by side.
- **Timeline**: an in-flight concurrency chart, gradient bars, marching stripes on running bars, links from each model step to its calls and from each Agent call to its lane, diamonds for marks, a live playhead, and hover tooltips. The terminal timeline gains an in-flight sparkline.
- Parallelism in the turn summary, station chips that filter the span list, and each span's share of the turn in the inspector.
- The view you pick is remembered across sessions.

## 0.1.0

- First release. A live swimlane trace in a pane beside the chat. It covers model steps, tool calls, subagent lanes, settings hooks, permission waits and background shells.
- A turn summary: time, steps, tool calls, errors, time waited on you, and tokens.
- Filters, a span list, an inspector with risk signals, and Copy as JSON.
- Three detail levels: Names only, Masked args and Full input.
- Draws as an Svg on desktop, VS Code and mobile, and in block characters in the terminal.
