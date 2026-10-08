# agents-visualizer

Live dashboard of one Claude Code session: the main agent, its advisor and its subagents, with the model each one runs, what it is doing, token use and cost.

It only reads the transcripts Claude Code already writes, and never writes into `~/.claude`:

- `~/.claude/projects/<project>/<sessionId>.jsonl` (main agent)
- `~/.claude/projects/<project>/<sessionId>/subagents/agent-<id>.jsonl` and `.meta.json` (subagents)

## Run

Requires Node 22+. There are no dependencies.

```sh
node server.js                       # most recently modified session
node server.js --session <id|path>   # a specific session
PORT=5000 node server.js
```

Open http://localhost:4321. You can switch sessions with the picker in the top right.

**Replay** is on by default for sessions that have been quiet for 60 s. It plays the backlog in timestamp order at 5x, 20x or 100x, or all at once with "instant", and caps idle gaps at 1 s. You can also set it in the URL, for example `?replay=1&speed=100&session=<path>`.

## Status line

`statusline.js` reads Claude Code's status-line JSON on stdin and prints one line, for example:

```
opus ● thinking · sonnet ✎ editing · haiku ▸ 38 files │ $0.12 vs $4.96
```

The two numbers are the session cost and what it would cost if every agent ran on the main model. Add it to `~/.claude/settings.json`:

```json
{ "statusLine": { "type": "command", "command": "node /path/to/agents-visualizer/statusline.js" } }
```

## Files

| File | Purpose |
|---|---|
| `server.js` | Tails the transcripts and pushes slimmed records over SSE (`/events`). Also serves `/api/sessions`. |
| `aggregate.js` | Shared parsing, aggregation and the **price table** (`PRICES`, USD per 1M tokens). The browser and `statusline.js` both use it. |
| `index.html` | The dashboard, written in vanilla JS and CSS. |
| `statusline.js` | The one-line status line. |

## Notes

- Usage is counted once per API message, because Claude Code repeats `usage` on every content-block line.
- A subagent counts as **done** when its last message is text-only or it calls `SubagentHandback`. It shows **PASS** or **FAIL** when the last line of its final message is exactly that word. It counts as **idle** after 45 s with no activity.
- Advisor calls appear in transcripts as a `server_tool_use` block named `advisor`. Their tokens appear only in `usage.iterations` (type `advisor_message`, with the advisor's model), not in the top-level usage, so the dashboard adds them separately at the advisor's price.
- The checkpoint pills are inferred. A real advisor call lights "before the plan" if no subagent has started yet, "same error twice" if a tool error just repeated, and "before done" if every subagent has finished. `EnterPlanMode`, repeated errors and turn ends also count.
- The footer's command line is reconstructed from the transcript's model and effort.
