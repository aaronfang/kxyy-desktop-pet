# Realtime Call Recovery

## Decision

Realtime TTS recovery is transport recovery, not conversation reset. A VoxCPM
service restart is the last resort after bounded same-process cleanup and
reconnect attempts fail.

## Invariants

- Cancelling a provider iterator never calls `close()` concurrently with an
  in-flight `next()`; the provider gate remains held until cleanup finishes.
- TTS admission is not the same as audible playback. A response may be
  cancelled and folded into a continuation until its first audio segment is
  sent. Once a segment starts, normal generation supersession applies.
- Continuation requests merge at most four trailing user parts and 512
  characters for one LLM request. The original user messages remain separate
  in the session ledger and Memory input; unplayed assistant drafts are not
  treated as audible history.
- Only final ASR user messages and a fully drained, playback-receipted
  assistant response enter the incremental Memory enqueue path.
- A managed transport loss first retries the same endpoint. Only after the
  bounded retry threshold may VoxCPM call `recover_voice_service`; Qwen and
  CosyVoice remain reconnect-only in this slice.
  Reconnection resets transport generation/audio ledgers but preserves the
  microphone, session id, chat history and Memory queue.
- WebSocket `open` is not recovery success. The current socket must complete a
  bounded `session: started` handshake, and replaced sockets cannot deliver
  control messages or audio.
- VoxCPM's latest generation waits up to five seconds for a cancelled provider
  iterator to finish cleanup. Only that explicit cleanup timeout, or three
  failed session handshakes, may request the App-managed last-resort restart.
- While transport recovery is visible as `语音恢复中`, microphone PCM and level
  feedback are intentionally not accepted or persisted. A long model reload
  cannot losslessly capture speech without an unbounded raw-audio buffer; chat
  history, audible receipts and Memory remain intact, and listening resumes
  only after the new session handshake.
- Old WebSocket generations and old managed audio frames cannot become audible
  after recovery.
- Pending-turn resume is explicitly negotiated and requires a final ASR turn
  that has not yet produced audible playback. A trailing historical user
  message alone never triggers regeneration.
- Each recovered transport starts a new backend generation namespace. The
  frontend preserves any current audible prefix first, then clears old
  generation/segment receipt ledgers before accepting the new session.
- Bounded recovery history reserves one slot for the latest explicit same-day
  role livestream state. The replacement service rebuilds this session-only
  state before its first reply, so a long call cannot turn an earlier "today
  you are not streaming" statement into an invented current/downstream state.
  A later explicit user correction replaces it. This volatile state never
  enters long-term Memory.
- Unless the user explicitly says they are leaving, sleeping, hanging up or
  saying goodbye, every local realtime backend receives a fixed continuation
  constraint at the end of its system prompt. Generated text is never rewritten
  with closing-phrase regexes because quoted, translated and example language
  must remain intact. Explicit farewells remain available to the model.

## Implemented slices

- VoxCPM provider cleanup now queues generator close on its single worker and
  releases the model gate after close completion.
- Local managed sessions expose a durable audible-response completion callback.
- Final user and complete audible assistant call records incrementally enqueue
  into Rust Memory with coalesced in-flight draining.
- Managed sessions reconnect with current chat history before requesting a
  service recovery/restart.
- Recovery waits through a live `starting` child without a short fixed timeout;
  an explicit process failure is terminal.
- The Rust restart revalidates backend, ASR provider, fingerprint and desired
  epoch while holding one lifecycle lock across stop and replacement ensure.
- Recoverable response errors and transport loss discard unplayed assistant
  drafts; a completed audible prefix is retained and incrementally enqueued.
- A recovered session sends only a text-free `resume_pending_turn` control when
  its bounded initial history ends with user messages; the service merges that
  trailing user run and regenerates the pending reply once.
- Recovery history remains capped at 12 messages / 4096 characters. It may
  replace the oldest ordinary slot with the latest same-day livestream-state
  statement, and the new service reconstructs the fixed session state from
  user messages without writing a new chat or Memory record.
- Assistant deltas retain their existing streaming granularity. Diagnostics
  continue to retain no transcript text. Playback receipts, not generated
  drafts, remain the source of assistant history and Memory.
- VoxCPM, Qwen and CosyVoice share the no-unsolicited-closing constraint. The
  constraint is prompt-level rather than a text post-processor, so chat display,
  spoken audio and audible history preserve the same unmodified reply.

## Verification

- Deterministic Python replay covers repeated interruption, pending-turn merge,
  provider cleanup timeout, service-restart negotiation, volatile-state
  reconstruction, explicit farewell preservation and filtered UI/TTS output.
- JavaScript tests cover bounded recovery-history preservation, stale transport
  rejection and transcript-free diagnostics.
- Rust tests cover desired-target epochs, lifecycle-lock recovery and child
  startup/exit state reporting.
- A real call confirmed that ordinary post-interruption replies remain audible.
  Forced provider cleanup timeout and process replacement still require a
  controlled real-device test.

## Remaining slices

1. Verify Rust lifecycle behavior on an actually exited child on macOS and
   Windows, including the slow-starting VoxCPM process.
2. Run one licensed real-device call replay covering a forced cleanup
   timeout/restart and post-recovery topic continuation. Ordinary interruption
   and continued audible reply have already passed a real call test.
