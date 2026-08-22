# Realtime Conversation v3: Recovery, Agency, and Adaptive Reasoning

Status: ready for implementation

## Problem Statement

Realtime calls are technically stable but can feel passive and brittle. A Confirmed Interruption can leave the character silent when the user does not contribute usable content. The current conversation director rotates reply shapes, but it does not reliably give the character a distinct Persona Stance, so many turns merely agree and ask another question. Enabling reasoning globally adds several seconds to ordinary turns without reliably producing deeper content. Existing deterministic tests verify internal plans but do not adequately measure the resulting conversational behavior, and high-volume playback observations can displace the critical events needed to diagnose early-call failures.

## Solution

Provide a deterministic conversation feedback loop, add a bounded Interruption Recovery path, evolve the director to select an explicit Conversation Move and Persona Stance, and select a per-turn Reasoning Policy. The character should recover once after an empty Confirmed Interruption, contribute opinions and gentle contrasts when appropriate, lead without interrogating the user, and reserve deliberate reasoning for turns that benefit from it. Critical diagnostic events must remain observable throughout a call.

## User Stories

1. As a caller, I want the character to continue naturally when I accidentally take the floor and then say nothing useful, so that the conversation does not die unexpectedly.
2. As a caller, I want rejected Speech Candidates to resume the existing audio, so that background noise does not create a new reply.
3. As a caller, I want an explicit request for silence to cancel all recovery and proactive speech, so that I retain control of the call.
4. As a caller, I want new speech to cancel a pending recovery immediately, so that the character never talks over my continuation.
5. As a caller, I want at most one recovery for one Confirmed Interruption, so that a quiet call does not produce repeated retries.
6. As a caller, I want recovery to rely only on Audible History, so that the character does not assume I heard an unfinished sentence.
7. As a caller, I want the character to answer requests for an opinion with a concrete position and reason, so that it feels like a participant rather than an interviewer.
8. As a caller, I want the character to support vulnerable or serious disclosures before introducing disagreement, so that agency does not become reflexive contrarianism.
9. As a caller, I want safe casual topics to allow gentle disagreement grounded in stable persona preferences, so that the character has recognizable tastes.
10. As a caller, I want the character to contribute a new detail after short acknowledgements, so that I can participate without carrying every topic.
11. As a caller, I want the character to lead a stalled topic without inventing personal experiences, so that it feels lively without becoming untrustworthy.
12. As a caller, I want the character to ask no more than one question per turn, so that the call does not feel like an interview.
13. As a caller, I want the character to follow me when I decline a new direction, so that leading remains cooperative.
14. As a caller, I want simple greetings and acknowledgements to respond quickly, so that global reasoning does not slow every exchange.
15. As a caller, I want decisions, relationships, complex feelings, comparisons, and explicit requests for reasons to receive deliberate reasoning, so that extra latency buys useful depth.
16. As a caller, I want a deep topic to retain deliberate reasoning briefly across follow-ups, so that the conversation does not oscillate unnaturally.
17. As a caller, I want recovery turns and proactive greetings to stay fast, so that mechanical control turns do not pay a reasoning penalty.
18. As a user, I want to choose reasoning off, automatic, or always on, so that I control the latency-quality tradeoff.
19. As a developer, I want a deterministic replay to detect passive agreement, repeated questioning, missing recovery, and incorrect reasoning selection, so that conversation changes have a tight feedback loop.
20. As a developer, I want critical speech, response, recovery, and proactive events preserved in diagnostics even during long calls, so that playback samples do not erase the failure.
21. As a developer, I want diagnostics to expose only fixed enums and bounded counts, so that improving observability does not leak conversation content.
22. As a maintainer, I want frontend and Python policy schemas to reject unknown values, so that old services degrade safely.
23. As a maintainer, I want existing Volcano and legacy behavior to remain unchanged when new capabilities are not negotiated, so that the feature does not imply unsupported provider behavior.
24. As a tester, I want real-device listening gates in addition to deterministic tests, so that passing internal plan assertions is not mistaken for a natural conversation.

## Implementation Decisions

- The highest deterministic seam is a replay of sanitized conversation events and final-ASR categories through the conversation director and realtime session protocol. Python tests mirror the private wire boundary.
- Diagnostics retain a bounded critical-event lane separate from coalesced high-volume playback observations. Export remains globally bounded and ordered by monotonic time.
- Interruption Recovery is distinct from rejected-candidate playback resumption and from continuation guidance for multiple valid user utterances.
- A recovery is eligible only after a Confirmed Interruption contributed no usable conversational content, the user stayed silent for a fixed grace period, the prior character response was incomplete, and no hard control or newer speech superseded it.
- Recovery is one-shot per interruption and uses a fixed private control kind. It never fabricates user text or PCM and never enters user history.
- Temporary reply, playback, or receipt occupancy defers recovery eligibility instead of permanently vetoing it. Every cancellation boundary invalidates stale recovery work.
- Turn Strategy v2 consists of Conversation Move, Persona Stance, Reasoning Policy, response cue, and bounded Conversation Depth.
- Conversation Move values are respond, expand, deepen, associate, and recover.
- Persona Stance values are support, opine, contrast, and lead.
- Reasoning Policy values are fast and deliberate.
- Conversation Depth is semantic and bounded from zero to three. Ordinary substantive turns do not mechanically increase it.
- Serious, sensitive, or vulnerable turns prefer support and prohibit lateral contrast until the conversation safely recovers.
- Explicit opinion requests select opine. Repeated low-information agreement on safe topics may select lead or contrast. Contrast must remain grounded in stable persona boundaries and must not invent personal experience.
- A turn contains no more than one question. Contribution precedes any response cue.
- User rejection of a led direction returns the next turn to the user's topic.
- The user-facing reasoning preference becomes off, automatic, or always. Existing boolean settings migrate without losing intent: false becomes off and true becomes always.
- Automatic reasoning selects deliberate for explicit depth, reasons, consequential choices, relationships, long-running concerns, complex emotion, or multi-condition comparison. It remains fast for greetings, farewells, acknowledgements, proactive welcome/follow-up, and Interruption Recovery.
- A deliberate topic may retain its policy for at most two eligible follow-up turns. Hard redirect, pause, topic change, or a fast-only control turn ends the carry.
- The managed local realtime request sends the selected reasoning decision explicitly on every turn. Unknown or absent values fall back to the persisted user preference.
- Runtime diagnostics expose fixed reasoning policy/source counters and recovery lifecycle counters without text, prompts, topic identity, or model reasoning.
- Current-information retrieval, restaurant/POI providers, external grounding, and new post-generation factual validation are not part of this work.

## Testing Decisions

- Tests assert externally meaningful director actions, protocol messages, recovery timing outcomes, and sanitized diagnostic reports rather than private helper implementation.
- A deterministic conversation replay covers acknowledgements, opinion requests, vulnerable disclosures, repeated agreement, topic rejection, and deep follow-ups.
- A deterministic interruption replay covers rejected candidates, empty Confirmed Interruptions, valid user continuations, deferred occupancy, cancellation by new speech, pause, redirect, hangup, and stale timer delivery.
- Frontend and Python table tests use the same fixed strategy values and reject malformed plans.
- Settings tests cover migration from the old boolean, all three persisted modes, and provider fallback.
- Latency tests compare automatic fast turns with always-deliberate turns while treating content quality as a separate listening gate.
- The full JavaScript, Python realtime, resource, Rust library, and Rust check commands run before completion.
- Real-device acceptance uses blinded ratings for naturalness, persona agency, leadership, depth, and interruption recovery. It is required before changing the default reasoning preference.

## Out of Scope

- Tavily or other realtime web-search integration.
- Restaurant, map, or POI providers.
- Unknown-entity resolution and current movie information.
- A new factual-claim or commitment post-generation validator.
- Changes to Volcano protocol constants or unsupported proactive generation.
- Neural VAD takeover, endpoint timing changes, partial ASR, or fake user input.
- Persisting conversation strategy, topic state, model reasoning, or recovery controls into Memory.

## Further Notes

The first release should keep automatic reasoning opt-in until real-device A/B results show that deliberate turns improve perceived depth without unacceptable latency. Increasing Persona Stance variety must remain conservative while the separate factual-integrity project is deferred: agency should come from opinions, preferences, observations, and topic selection rather than invented real-world experience.
