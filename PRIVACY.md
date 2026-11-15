# Privacy

Agent Trace runs inside your Claude Code session and sends nothing anywhere.

## What it records

For each turn, it records the timing of model steps, tool calls, subagents, settings hooks and permission prompts. It keeps them in the session's state, which Claude Code holds in memory for that session. The trace is not written to disk and is gone when the session ends.

How much of a tool call's input it keeps depends on the **Detail kept** setting:

- **Names only** (default): the tool's name and a short label built from names only. That means a file's base name, a web host or the program a shell command runs. Arguments and output are not kept.
- **Masked args**: the arguments, with values that look like secrets hidden and any text longer than 60 characters replaced by its length.
- **Full input**: the whole arguments, cut at 4,000 characters, with recognisable keys and tokens still hidden.

Results are summarised. At Names only and Masked args a result is a line count and a character count. At Full input, the first 300 characters are kept as well.

## What it stores across sessions

Two choices are stored, in the plugin's own store in Claude Code: your **Detail kept** level and the view you last picked (Map, Timeline or Insights). Nothing from the trace is stored.

## What it sends

Nothing. Agent Trace makes no network requests and calls no model. **Copy as JSON** puts one span on your clipboard only when you press it.
