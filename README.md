# Local Ollama ↔︎ MCP Agent

This project glues a local Ollama model to any Model Context Protocol server (tested with [`ksp-mcp`](https://github.com/caseys/ksp-mcp)).  
It mirrors the “Claude Desktop + MCP” workflow: the agent calls Ollama’s `/api/chat`, exposes MCP tools as OpenAI-style functions, and keeps looping until the model emits a final answer.

## Highlights

- **Single-file Node.js agent** – no frameworks, just a readable event loop that works on macOS with Node.js ≥ 18.
- **Dynamic tool surfacing** – every MCP tool is auto-converted into OpenAI function metadata, including stemmed name/description tokens, so the agent can rank the best-matching tools per turn even when prompts use synonyms.
- **Persistent command history** – the last five prompts (plus tool successes/failures and short answer summaries) are prepended to each new user turn, giving the LLM continuity without overwhelming context. Older entries are noted as hidden.
- **Structured tool reminders** – when a tool result references another tool (“Use setTarget first”), the agent adds lightweight follow-up reminders so the model retries before asking the user to do it manually.
- **Clean logging & shutdown** – stdout shows every tool call/result, outputs are sanitized before entering the chat history, and Ctrl+C triggers a graceful shutdown of the MCP transport.
- **Transport choice** – stdio is the default (the agent will spawn `../ksp-mcp/dist/index.js`), but HTTP mode is available when MCP is hosted separately.

## Prerequisites

- macOS with Node.js ≥ 18 (ships with native `fetch`)
- [Ollama](https://ollama.com) running locally (default `http://localhost:11434`)
- The `ksp-mcp` repo cloned adjacent to this project (`../ksp-mcp`) **or** another MCP endpoint exposing the desired tools

## Install

```bash
cd /Users/casey/src/ollama-tools
npm install
# optional: copy defaults for ksp-mcp
cp .env.example .env
```

## Run

```bash
# stdio transport (default): spawns ../ksp-mcp/dist/index.js
npm start

# HTTP transport (when ksp-mcp is already running via HTTP)
node agent.js --transport http --mcpHttpUrl http://127.0.0.1:3000/mcp
```

Type `exit` (or press Ctrl+C once) to leave the REPL cleanly.

## Configuration reference

Each option can be supplied via CLI flag or environment variable.

| Flag | Env var | Default | Description |
| --- | --- | --- | --- |
| `--model <name>` | `OLLAMA_MODEL` | `llama3.2:3b-instruct-q4_K_M` | Ollama model pulled from `/api/chat` |
| `--ollamaUrl <url>` | `OLLAMA_URL` | `http://localhost:11434` | Base Ollama endpoint |
| `--systemPrompt <text>` | `SYSTEM_PROMPT` | Strict "always call tools, never fabricate" prompt | System instruction sent to the model |
| `--transport <stdio|http>` | `MCP_TRANSPORT` | `stdio` | MCP transport selection |
| `--mcpBin <path>` | `MCP_BIN` | `../ksp-mcp/dist/index.js` | Binary spawned for stdio sessions |
| `--mcpHttpUrl <url>` | `MCP_HTTP_URL` | `http://127.0.0.1:3000/mcp` | HTTP endpoint when `--transport http` |
| `--maxIterations <n>` | `MAX_ITERATIONS` | `20` | Max agent loop iterations before returning |
| `--maxRetries <n>` | `MAX_RETRIES` | `3` | Ollama call retry attempts with exponential backoff |
| `--coreTools <list>` | `CORE_TOOLS` | (empty) | Comma-separated tools to always include in selection |

### Using dotenv

The agent automatically loads `.env` via [`dotenv`](https://github.com/motdotla/dotenv).  
Start from the provided `.env.example`, tweak any values (model, MCP binary, preferred core tools), and they will be picked up on launch—CLI flags still override env vars when both are set.

Default system prompt (used unless you override it):

```
You are a tool-using assistant. Call tools whenever outside data or actions are needed, and supply only the parameters defined in each schema. Use the provided history to avoid repeating failed actions. If a tool response tells you to run another tool, run it yourself and retry before answering—never ask the user to do it. Do not guess or fabricate tool output.
```

Example with an explicit stdio binary:

```bash
MCP_BIN=/Users/casey/src/ksp-mcp/dist/index.js npm start
```

If `MCP_BIN` ends with `.js/.mjs/.cjs`, the agent automatically spawns it with `node`, so pointing at `../ksp-mcp/dist/index.js` works even if the file isn’t executable.

Example specifying core tools that should always be available:

```bash
CORE_TOOLS="kos_status,kos_execute,mechjeb_set_target" npm start
```

> Tip: If you set `MCP_BIN` via `.env`, prefer an absolute path (e.g., `/Users/<you>/src/ksp-mcp/dist/index.js`). Relative paths are resolved from the shell directory when you launch the agent.

## How it works

1. **Connect to MCP** – `agent.js` spawns (or connects to) the MCP service, loads the tool list, and builds:
   - OpenAI-compatible function definitions,
   - Search tokens for ranking,
   - “Recommended tool” backlinks when a description references another tool.
2. **Prime the model** – the system message includes both the strict tool-usage instructions and a short primer listing up to 12 tools.
3. **Interactive loop** – for each user prompt the agent:
   - Prepends the last five history entries (`prompt → tool outcomes → short answer`) to the new request.
   - Calls Ollama with the conversation and the current tool subset.
   - Detects any `tool_calls`, executes the referenced MCP tool, logs/sanitizes the result, and feeds it back as a `tool` message.
   - Adds follow-up reminders whenever results mention a prerequisite or the MCP client throws (“Use setTarget first”, timeouts, etc.).
   - Repeats until the model produces natural language without tool calls.

This design stays general-purpose—no Kerbal-specific heuristics—so other MCP services can be dropped in as long as they expose tools via the standard schema.

## History + reminder behavior

- Up to five past prompts are summarized with their tool events (`✅` for success, `❌` for failures) and the opening of the final response. If more than five exist, the header notes how many were hidden.
- Tool output is collapsed to ASCII, whitespace-normalized text before being echoed or stored in history, preventing log noise from polluting context.
- When a tool response explicitly references other tool names, the agent pushes a short reminder message (“Call mechjeb_set_target before retrying.”). This keeps retries self-contained instead of bouncing instructions back to the user.
- Error paths (timeouts, MCP exceptions) still produce tool history entries so the model knows a previous attempt failed.

## Example session

```text
$ node agent.js
[agent] Connecting to MCP server (stdio) to read tools...
[agent] Loaded 42 MCP tools and exposed them to Ollama.
[agent] Ready. Type a prompt (or "exit" to quit). Example: "Check the current kOS status."
you> Using ksp-mcp, set the target to the Mun, then create a Hohmann transfer and report the maneuver.
[agent] Tools for this turn: mechjeb_set_target, mechjeb_hohmann_transfer, kos_set_target, kos_status, mechjeb_execute_node, ...
[agent] Asking Ollama (llama3.2:3b-instruct-q4_K_M) with 2 messages and 12 tool(s)...
[agent] → Executing MCP tool "kos_set_target" with args { name: 'Mun', type: 'body' }
[agent] ← Tool "kos_set_target" result:
Target set successfully!
Target: Mun (Body)
Radius: 200 km
[agent] Asking Ollama (llama3.2:3b-instruct-q4_K_M) with 4 messages and 12 tool(s)...
[agent] → Executing MCP tool "mechjeb_hohmann_transfer" with args { capture: false, timeReference: 'COMPUTED' }
[agent] ← Tool "mechjeb_hohmann_transfer" result:
created node at UT 123456. Apoapsis 11,412 km. Burn Δv: 862 m/s prograde.
[agent] Model returned final response.
assistant> Target locked on the Mun and a Hohmann transfer node is waiting at UT 123456 (862 m/s prograde, periapsis 12 km). Execute it when ready.
```

Subsequent prompts automatically include a summary like:

```
History: last 1
1. Using ksp-mcp, set the target to the Mun, then create a Hohmann transfer and report the maneuver.
   tools: kos_set_target✅:Target set successfully!; mechjeb_hohmann_transfer✅:created node at UT 123456...
   result: Target locked on the Mun and a Hohmann transfer node is waiting at UT 123456...
```

## Troubleshooting

- **`Tool mechjeb_execute_node is already registered`** – pull the latest `ksp-mcp` changes; old builds registered duplicates.
- **Timeouts** – if a long-running MCP tool times out, the agent logs the MCP error, records it in history, and reminds the model to retry the same tool before falling back to prerequisites.
- **Verify Ollama** – `curl http://localhost:11434/api/tags` should return your local model list.
- **Verify MCP alone** – run `../ksp-mcp/dist/index.js --transport stdio` (or `--transport http`) to ensure it boots without errors before letting the agent spawn it.

Once both services respond, `node agent.js` will keep looping until you exit.
