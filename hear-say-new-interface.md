# Migration Guide: New `say()` Interface

This document covers breaking changes and new features in the updated hear-say API.

## Breaking Changes

### `interrupt()` and `raiseHand()` Removed

These functions have been removed. Use `say()` with options instead:

| Old API | New API |
|---------|---------|
| `interrupt(text)` | `say(text, { rude: true })` |
| `raiseHand(text)` | `say(text, { latest: true })` |

## New `say()` Options

The `say()` function now accepts an optional second parameter:

```typescript
import { say, SayOptions } from 'hear-say';

say(text: string | false, options?: SayOptions): Promise<void>
```

### Options

| Option | Description |
|--------|-------------|
| `interrupt` | Skip to front of queue, wait for current item to finish. Last call wins. |
| `clear` | Clear the queue after current item finishes. Implies `interrupt`. |
| `rude` | Cut off current speech immediately and speak now. Combine with `clear` to also clear the queue. |
| `latest` | Only the last call with this flag wins (supersedes previous). Can combine with other options. |

### Behavior Matrix

| Options | Position | Waits? | Clears? | Supersedes? |
|---------|----------|--------|---------|-------------|
| `{}` | End | queued | No | No |
| `{ latest: true }` | End (keeps slot) | queued | No | Yes |
| `{ interrupt: true }` | Front | Yes | No | Yes |
| `{ latest: true, interrupt: true }` | Front | Yes | No | Yes |
| `{ clear: true }` | Front | Yes | Yes | Yes |
| `{ latest: true, clear: true }` | Front | Yes | Yes | Yes |
| `{ rude: true }` | Immediate | No | No | No |
| `{ rude: true, latest: true }` | Immediate | No | No | Yes |
| `{ rude: true, clear: true }` | Immediate | No | Yes | No |

### Examples

```typescript
// Queue normally (unchanged)
say("Hello");
say("World");
// Result: "Hello" → "World"

// Polite interrupt - wait for current, then speak next
say("Long explanation...");
say("Quick update", { interrupt: true });
say("Another thing");
// Result: "Long explanation..." → "Quick update" → "Another thing"

// Multiple interrupts - last one wins
say("Talking...");
say("Update 1", { interrupt: true });
say("Update 2", { interrupt: true });
say("Update 3", { interrupt: true });
// Result: "Talking..." → "Update 3"

// Latest - append to queue, subsequent calls replace in place
say("Item 1");
say("Item 2");
say("Note A", { latest: true });  // Queue: [1, 2, A*]
say("Item 3");                     // Queue: [1, 2, A*, 3]
say("Note B", { latest: true });  // Queue: [1, 2, B*, 3] - A replaced
// Result: "Item 1" → "Item 2" → "Note B" → "Item 3"

// Latest + interrupt - front of queue, last wins
say("Long speech...");
say("Update 1", { latest: true, interrupt: true });
say("Update 2", { latest: true, interrupt: true });
// Result: "Long speech..." → "Update 2"

// Clear queue after current finishes
say("Item 1");
say("Item 2");
say("Item 3");
say("Important!", { clear: true });
// Result: "Item 1" → "Important!" (Items 2 and 3 never spoken)

// Rude - cut off immediately, queue continues after
say("Blah blah blah...");
say("Queued item");
say("STOP!", { rude: true });
// Result: "Blah bl—" → "STOP!" → "Queued item"

// Rude + clear - cut off and clear everything
say("Blah blah blah...");
say("Queued item");
say("EMERGENCY!", { rude: true, clear: true });
// Result: "Blah bl—" → "EMERGENCY!" (Queued item never spoken)

// Stop all speech
say(false);
```

## New Features

### Dynamic Speech Rate

Speech rate now automatically scales based on queue size:

| Queue Size | Rate (wpm) |
|------------|------------|
| 0 | 230 |
| 1 | 258 |
| 2 | 286 |
| 3 | 314 |
| 4 | 342 |
| 5+ | 370 |

This helps the system "catch up" when many items are queued.

### Gap System (Listen Between Queue Items)

When multiple items are queued, `hear` can now listen for user speech between items. After each item (except the last), there's a 2-second gap where the microphone is active.

If the user speaks during a gap:
- The registered `hear` callback receives the text
- The gap ends early once speech processing completes
- The queue continues

```typescript
import { setGapDuration } from 'hear-say';

// Configure gap duration (default: 2000ms)
setGapDuration(3000);  // 3 seconds

// Disable gaps entirely
setGapDuration(0);
```

**Gap event hooks** (for advanced use cases):

```typescript
import { onSayGapStart, onSayGapEnd, signalGapSpeechComplete } from 'hear-say';

// Called when a gap starts
onSayGapStart(() => {
  console.log('Gap started, listening...');
});

// Called when a gap ends
onSayGapEnd(() => {
  console.log('Gap ended, resuming speech');
});

// Signal that speech was captured (called automatically by hear)
signalGapSpeechComplete();
```

## Full API Reference

### Exports

```typescript
// Core functions
say(text: string | false, options?: SayOptions): Promise<void>
hear(callback: Callback | false, timeoutMs?: number): void
loopback(text: string, options?: LoopbackOptions): Promise<string>

// State
getLastSpoken(): string
isSpeaking(): boolean

// Events
onSayStarted(callback: () => void): () => void
onSayFinished(callback: () => void): () => void
onSayGapStart(callback: () => void): () => void
onSayGapEnd(callback: () => void): () => void

// Configuration
setGapDuration(ms: number): void
signalGapSpeechComplete(): void

// Types
type SayOptions = {
  interrupt?: boolean;
  clear?: boolean;
  rude?: boolean;
  latest?: boolean;
}
```
