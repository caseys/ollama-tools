# Updating to the New `hear()` API

## Breaking Change

The `hear()` callback signature has changed to support real-time streaming of speech recognition results.

### Before

```ts
hear((text, stop) => {
  console.log("You said:", text);
}, 1600);
```

The callback was called **once** after a silence timeout with the final recognized text.

### After

```ts
hear((text, stop, final) => {
  console.log("You said:", text, "final:", final);
}, 1600);
```

The callback is now called:
- **Multiple times** as speech is recognized (`final = false`)
- **Once more** after the silence timeout with the complete text (`final = true`)

## Migration

### Minimal Change

If you only care about the final result (previous behavior), add `final` to your callback and check it:

```ts
// Before
hear((text, stop) => {
  processText(text);
}, 1600);

// After
hear((text, stop, final) => {
  if (final) {
    processText(text);
  }
}, 1600);
```

### Using Streaming

To show real-time feedback as the user speaks:

```ts
hear((text, stop, final) => {
  if (final) {
    // User finished speaking - process the result
    console.log("Complete:", text);
    respondToUser(text);
  } else {
    // Real-time update - show feedback
    updateLiveTranscript(text);
  }
}, 1600);
```

## Callback Arguments

| Argument | Type | Description |
|----------|------|-------------|
| `text` | `string` | The recognized speech text |
| `stop` | `() => void` | Call to stop listening entirely |
| `final` | `boolean` | `true` when silence timeout fired, `false` for streaming updates |

## Notes

- The `text` in streaming updates (`final = false`) represents the current recognition state
- The `text` in the final callback (`final = true`) is the complete utterance after TTS filtering
- Calling `stop()` at any point will stop listening and prevent automatic restart

---

# `loopback()` Streaming Support

The `loopback()` function now also supports an optional streaming callback with the same `(text, final)` pattern.

## Signature

```ts
loopback(
  text: string,
  timeoutMs?: number,
  onLine?: (text: string, final: boolean) => void
): Promise<string>
```

## Usage

### Without streaming (unchanged)

```ts
const result = await loopback("Hello world");
console.log("Heard:", result);
```

### With streaming

```ts
const result = await loopback("Hello world", 1200, (text, final) => {
  if (final) {
    console.log("Final transcription:", text);
  } else {
    console.log("Streaming:", text);
  }
});
```

The function still returns the final transcribed text via the Promise, but now you can also observe real-time progress via the optional callback.
