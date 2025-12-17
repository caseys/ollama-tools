# Code Review: ollama-tools

## Summary

This is a well-designed, minimal (~800 lines) single-file agent that bridges Ollama LLMs with MCP tools. The architecture is clean and the code is readable. Below are observations organized by category with specific recommendations.

---

## Strengths

1. **Minimal dependencies** - Only `@modelcontextprotocol/sdk` needed (zod comes with it)
2. **Transport-agnostic** - stdio/HTTP abstraction is clean
3. **Smart context management** - History summarization prevents context explosion
4. **Auto-retry via reminders** - Clever pattern to keep model self-correcting
5. **Type coercion** - Handles Ollama's string-ification of booleans/numbers
6. **Clean shutdown** - Proper SIGINT handling

---

## Issues & Recommendations

### 1. Unused Dependency
**File:** `package.json:18`

`zod` is listed but never imported or used in `agent.js`. Either remove it or use it for runtime schema validation.

**Recommendation:** Remove from dependencies unless you plan to add schema validation.

---

### 2. KSP-Specific Hardcoding
**File:** `agent.js:35-43`

```javascript
const ALWAYS_INCLUDE_TOOLS = [
  'kos_status',
  'kos_connect',
  // ... all KSP-specific
];
```

This limits generalization to other MCP servers.

**Recommendation:** Make this configurable:
```javascript
// Via CLI/env:
--alwaysIncludeTools "tool1,tool2,tool3"
// Or discover "core" tools via a naming convention or metadata
```

---

### 3. No Token/Context Limit Awareness
**File:** `agent.js:270-294`

The conversation grows unbounded within a session. While history summarization helps across prompts, a single long agent loop can overflow context.

**Recommendation:**
- Add a `--maxContextTokens` option
- Use a simple token estimator (4 chars ≈ 1 token)
- Truncate oldest messages when approaching limit
- Or use tiktoken-like library for accuracy

---

### 4. No Streaming Support
**File:** `agent.js:276`

```javascript
stream: false,
```

Long-running tool sequences show no progress until completion.

**Recommendation:** Add `--stream` flag to enable streaming mode:
```javascript
stream: config.stream,
// Then handle SSE chunks, printing assistant tokens as they arrive
```

---

### 5. No Retry Logic for Ollama Failures
**File:** `agent.js:287-293`

Network blips cause immediate failure.

**Recommendation:** Add exponential backoff retry:
```javascript
async function callOllamaWithRetry(messages, tools, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await callOllama(messages, tools);
    } catch (e) {
      if (i === maxRetries - 1) throw e;
      await sleep(Math.pow(2, i) * 1000);
    }
  }
}
```

---

### 6. Tool Selection Could Be Smarter
**File:** `agent.js:349-410`

Keyword matching is simple but misses semantic relationships. "transfer to moon" won't match `mechjeb_hohmann_transfer` well.

**Recommendations (pick one):**

**A. Lightweight:** Add synonyms/aliases in tool metadata
```javascript
// Tool entry could have aliases
aliases: ['transfer', 'orbit change', 'hohmann']
```

**B. Medium:** Use a small embedding model for semantic similarity
```javascript
// Pre-compute tool description embeddings
// At runtime, embed user query, find nearest tools
```

**C. Simple improvement:** Score partial word matches, not just exact
```javascript
// "hohmann" partially matches "hohmann_transfer"
if (entry.searchText.includes(keyword) ||
    keyword.includes(entry.openAi.function.name.split('_')[1])) {
```

---

### 7. system.txt Is Not Used
**File:** `system.txt` exists but `agent.js` uses `DEFAULT_SYSTEM_PROMPT` inline.

The file contains a different, shorter prompt than what's in code.

**Recommendation:** Either:
- Delete `system.txt` (it's misleading)
- Or load it as the default: `fs.readFileSync('./system.txt', 'utf8')`

---

### 8. No Parallel Tool Execution
**File:** `agent.js:652-700`

Tools are executed sequentially in a `for...of` loop.

**Recommendation:** If tools don't depend on each other, execute in parallel:
```javascript
const results = await Promise.allSettled(
  toolCalls.map(call => executeToolCall(call, client, toolInventory))
);
```

This could significantly speed up multi-tool turns.

---

### 9. No Max Iterations Guard
**File:** `agent.js:621`

The `while (true)` loop has no iteration limit. A confused model could loop forever.

**Recommendation:** Add a max iterations constant:
```javascript
const MAX_AGENT_ITERATIONS = 20;
let iterations = 0;
while (iterations++ < MAX_AGENT_ITERATIONS) {
```

---

### 10. Logging Could Be Configurable
**File:** Throughout `agent.js`

All logging goes to console. No way to reduce verbosity or log to file.

**Recommendation:** Add `--verbose` / `--quiet` flags:
```javascript
const log = config.quiet ? () => {} : console.log;
const debug = config.verbose ? console.log : () => {};
```

---

### 11. Consider Splitting the File
**File:** `agent.js`

800 lines is manageable but approaching the point where splitting helps:

```
src/
  index.js          # Entry point, CLI parsing, main loop
  ollama.js         # callOllama, streaming logic
  mcp.js            # connectToMcp, transport setup
  tools.js          # Tool conversion, selection, scoring
  history.js        # Conversation history management
  utils.js          # sanitizeToolText, coercePrimitive, etc.
```

**Trade-off:** Single-file is nice for deployment simplicity. Consider only if the file grows further.

---

### 12. Error Messages Could Include Recovery Hints
**File:** `agent.js:682-698`

When tools fail, the error is logged but no recovery suggestion is given to the model.

**Recommendation:** Enhance error messages:
```javascript
const errorBlock = sanitizeToolText(
  `Tool ${name} failed: ${message}\n` +
  `Suggestion: Check if prerequisites are met or try with different parameters.`
);
```

---

## Performance Quick Wins

1. **Cache tool inventory** - Don't rebuild `searchText`/`searchTokens` every call
2. **Lazy tool loading** - Load full schemas only when tool is actually called
3. **Connection pooling** - For HTTP transport, reuse connections

---

## Future Architecture Considerations

### 1. Plugin System for MCP Servers
Instead of one MCP connection, support multiple:
```javascript
mcpServers: [
  { name: 'ksp', bin: '../ksp-mcp/dist/index.js' },
  { name: 'filesystem', bin: 'mcp-filesystem' },
]
```

### 2. Tool Categories
Group tools by category for smarter selection:
```javascript
categories: {
  navigation: ['hohmann_transfer', 'change_inclination'],
  status: ['kos_status', 'vessel_info'],
}
```

### 3. Memory/RAG Integration
For long-running sessions, integrate vector store for:
- Semantic tool search
- Long-term memory across sessions
- Example-based tool selection

---

## Recommended Priority Order

| Priority | Change | Effort | Impact |
|----------|--------|--------|--------|
| 1 | Remove unused `zod` dep | 1 min | Cleanliness |
| 2 | Add max iterations guard | 5 min | Reliability |
| 3 | Make ALWAYS_INCLUDE_TOOLS configurable | 15 min | Generalization |
| 4 | Delete or use system.txt | 5 min | Cleanliness |
| 5 | Add retry logic for Ollama | 20 min | Reliability |
| 6 | Add --verbose/--quiet flags | 15 min | UX |
| 7 | Add context limit awareness | 1 hr | Reliability |
| 8 | Add streaming support | 2 hr | UX |
| 9 | Parallel tool execution | 30 min | Performance |

---

## Implementation Plan

Based on feedback:
- **Scope:** Any MCP server (generalize away from KSP)
- **Approach:** Staged - reliability first, modularization later
- **Priority:** Generalization + Reliability in single file, then split once stable

### Stage 1: Reliability & Generalization (Keep Single File)

Add these features to `agent.js` without restructuring:

#### 1.1 Remove unused zod
```bash
npm uninstall zod
```

#### 1.2 Add max iterations guard
```javascript
const MAX_AGENT_ITERATIONS = config.maxIterations ?? 20;
let iterations = 0;
while (iterations++ < MAX_AGENT_ITERATIONS) {
  // existing loop body
}
if (iterations >= MAX_AGENT_ITERATIONS) {
  console.warn('[agent] Max iterations reached, returning last response');
}
```

#### 1.3 Add Ollama retry with exponential backoff
```javascript
async function callOllamaWithRetry(messages, tools, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await callOllama(messages, tools);
    } catch (e) {
      if (attempt === maxRetries) throw e;
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
      console.log(`[agent] Ollama retry ${attempt}/${maxRetries} in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}
```

#### 1.4 Make core tools configurable
```javascript
// Replace hardcoded ALWAYS_INCLUDE_TOOLS with:
const coreToolsRaw = config.coreTools ?? process.env.CORE_TOOLS ?? '';
const ALWAYS_INCLUDE_TOOLS = coreToolsRaw
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
```

#### 1.5 Delete or use system.txt
Either delete the file, or load it dynamically.

### Stage 2: Modularization (Later)

Once Stage 1 is stable, split into `src/` modules. Deferred to avoid debugging layout + features simultaneously.

### Stage 3: Nice-to-Haves (Future)

- Streaming support (`--stream`)
- Context token estimation and trimming
- Parallel tool execution
- Config file support
- `--verbose` / `--quiet` flags

---

## Revised Implementation Order

**Stage 1 Tasks (in order):**

| # | Task | File | Effort |
|---|------|------|--------|
| 1 | Remove `zod` dependency | package.json | 1 min |
| 2 | Add `--maxIterations` CLI option | agent.js | 5 min |
| 3 | Add iteration guard to agent loop | agent.js:621 | 5 min |
| 4 | Add `--maxRetries` CLI option | agent.js | 5 min |
| 5 | Wrap `callOllama` with retry logic | agent.js | 15 min |
| 6 | Add `--coreTools` CLI option | agent.js | 5 min |
| 7 | Make `ALWAYS_INCLUDE_TOOLS` configurable | agent.js:35-43 | 10 min |
| 8 | Delete `system.txt` or load dynamically | agent.js, system.txt | 5 min |
| 9 | Update README with new options | README.md | 10 min |

---

## Files Modified in Stage 1

| File | Changes |
|------|---------|
| `package.json` | Remove zod |
| `agent.js` | Add CLI options, retry logic, iteration guard, configurable core tools |
| `system.txt` | Delete or keep (if loading dynamically) |
| `README.md` | Document new CLI options |

---

## New Configuration Options (Stage 1)

| Option | Env | Default | Description |
|--------|-----|---------|-------------|
| `--coreTools` | `CORE_TOOLS` | `""` | Comma-separated tools to always include |
| `--maxIterations` | `MAX_ITERATIONS` | `20` | Max agent loop iterations |
| `--maxRetries` | `MAX_RETRIES` | `3` | Ollama call retry attempts |
