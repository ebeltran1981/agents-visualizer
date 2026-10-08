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
- A subagent counts as **done** when its last message is text-only or it calls `SubagentHandback`. It shows **PASS** or **FAIL** when its final text contains those words in uppercase. It counts as **idle** after 45 s with no activity.
- Transcripts don't log advisor calls, so the advisor card shows the checkpoint moments that can be detected instead: `EnterPlanMode`, the same tool error seen twice, and the main turn ending. Claude Code hooks (`SubagentStart`/`SubagentStop`/`PostToolUse`/`Stop`) could add precise events later.
- The footer's command line is reconstructed from the transcript's model and effort.
