---
status: accepted
---

# Separate background companionship from ordinary realtime calls

Background Companion Call is a separate session type rather than a fourth ordinary-call initiative setting. Its first release uses VoxCPM2, deliberate push-to-talk, no idle microphone capture, and minute-scale bounded initiative because ordinary calls assume continuous microphone audio and second-scale turn taking; combining both policies would make privacy, timing, recovery, and provider behavior ambiguous. Shared Experience Session may later supply explicitly authorized media observations to a Background Companion Call, but neither session silently enables the other.

## Consequences

- The first release does not offer ambient free speech, wake-word activation, online voice APIs, or screen/system-audio observation.
- The conversation policy remains provider-neutral, but only VoxCPM2 is a release and acceptance target.
- A distinct capability handshake is required for push-to-talk segment controls; old local services and ordinary calls retain their current behavior.
- Right Alt is the default observed physical key. It is never suppressed, and Windows AltGr ambiguity must fail closed or require a different configured key.
