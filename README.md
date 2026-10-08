# agents-visualizer

Live dashboard of one Claude Code session: the main agent, its advisor and its subagents, with the model each one runs, what it is doing, token use and cost.

It only reads the transcripts Claude Code already writes, and never writes into `~/.claude`:

- `~/.claude/projects/<project>/<sessionId>.jsonl` (main agent)
- `~/.claude/projects/<project>/<sessionId>/subagents/agent-<id>.jsonl` and `.meta.json` (subagents)

## Setup

You need Node 22 or later, and Claude Code installed on the same computer, since the dashboard reads its transcripts. There is nothing to install.

```sh
git clone git@github.com:ebeltran1981/agents-visualizer.git
cd agents-visualizer
node --version   # v22 or later
```

## Use

Start the server, then open http://localhost:4321.

```sh
node server.js                       # opens the most recently modified session
node server.js --session <id|path>   # opens a specific session
PORT=5000 node server.js             # uses another port
```

- **Pick a session** with the dropdown in the top right. It lists the 40 most recent sessions on this computer, labelled by project folder and session id.
- **Live sessions** stream in as Claude Code writes them. Leave the dashboard open while you work in another terminal.
- **Finished sessions** replay by default (any session quiet for 60 s). Choose 5x, 20x or 100x, or "instant" to load everything at once. Untick "replay" to load without playback.
- **URL parameters** make a view shareable or scriptable: `?session=<path>&replay=1&speed=20`.

What the dashboard shows:

| Panel | Meaning |
|---|---|
| Header | How many models the session used, and what each one did (plans, reads, edits, reviews). |
| Main session | The main agent's model, effort, current activity, files, tools, tokens and cost. |
| Advisor | The advisor model, its three checkpoint pills, the number of real advisor calls, and the tokens and cost of those calls. |
| Subagents | One card per subagent: model, type, effort, activity and state (working, idle, done, PASS or FAIL). |
| The read bill | What the subagents' reading cost on their own models, compared with the same tokens on the main model. |
| Session log | Every tool call, message, error and advisor call, with timestamps and day dividers. |
| Footer | The reconstructed command line, the effort levels, the subagent count and the advisor's state. |

## Getting a multi-model session

The dashboard is most useful when a session mixes models. In the project you are working on:

1. **Give each subagent role its own model** in `.claude/agents/<name>.md`:

   ```markdown
   ---
   name: explorer
   description: Read-only. Searches and reads the codebase and reports what it found.
   model: claude-haiku-4-5
   tools: Read, Grep, Glob
   ---

   You are a read-only explorer. Report file paths and facts, never edit files.
   ```

   A `worker` with `model: claude-sonnet-5-5` and edit tools makes a good companion. Ask workers and reviewers to end their final message with a line containing only `PASS` or `FAIL`; the cards key on that line.

2. **Turn on the advisor** with `/advisor` inside Claude Code, or set `"advisorModel": "fable"` in `~/.claude/settings.json`.

3. **Start the main session** on the model you want to lead, for example `claude --model opus --effort high`, and ask it to delegate to those subagents.

## Status line

`statusline.js` reads Claude Code's status-line JSON on stdin and prints one line, for example:

```
opus ● thinking · sonnet ✎ editing · haiku ▸ 38 files │ $0.12 vs $4.96
```

The two numbers are the session cost and what it would cost if every agent ran on the main model. Add it to `~/.claude/settings.json`, using the absolute path of your clone:

```json
{ "statusLine": { "type": "command", "command": "node /path/to/agents-visualizer/statusline.js" } }
```

## Prices

Costs come from the `PRICES` table at the top of `aggregate.js`, in USD per 1M tokens (input, output, cache read, 5-minute cache write). A model missing from the table shows `?` instead of a guessed price; add a row to fix it.

## Files

| File | Purpose |
|---|---|
| `server.js` | Tails the transcripts and pushes slimmed records over SSE (`/events`). Also serves `/api/sessions`. |
| `aggregate.js` | Shared parsing, aggregation and the price table. The browser and `statusline.js` both use it. |
| `index.html` | The dashboard, written in vanilla JS and CSS. |
| `statusline.js` | The one-line status line. |

## Notes

- Usage is counted once per API message, because Claude Code repeats `usage` on every content-block line.
- A subagent counts as **done** when its last message is text-only or it calls `SubagentHandback`. It shows **PASS** or **FAIL** when the last line of its final message is exactly that word. It counts as **idle** after 45 s with no activity.
- Advisor calls appear in transcripts as a `server_tool_use` block named `advisor`. Their tokens appear only in `usage.iterations` (type `advisor_message`, with the advisor's model), not in the top-level usage, so the dashboard adds them separately at the advisor's price.
- The checkpoint pills are inferred. A real advisor call lights "before the plan" if no subagent has started yet, "same error twice" if a tool error just repeated, and "before done" if every subagent has finished. `EnterPlanMode`, repeated errors and turn ends also count.
- The footer's command line is reconstructed from the transcript's model and effort.
- If the server restarts while a page is open, the page reconnects and counts the backlog twice. Reload the page.
