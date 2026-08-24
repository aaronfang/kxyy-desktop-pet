# KXYY Desktop Pet

This context describes the user-visible conversation concepts shared by text chat, realtime voice, persona behavior, and local orchestration.

## Realtime Conversation

**Background Companion Call**:
An explicitly started, long-running voice session for sparse conversation while the user focuses on another activity. It uses deliberate Talk Holds and bounded, low-frequency character initiative without observing the user's screen or ambient media.
_Avoid_: Realtime call mode, Shared Experience Session, always-on call

**Talk Hold**:
A deliberate request for the conversational floor that begins when the configured push-to-talk control is pressed and ends when it is released or reaches its safety limit. It is not an acoustically inferred Speech Candidate.
_Avoid_: Speech Candidate, wake word, interruption

**Continuation Window**:
A bounded interval after a safety-ended Talk Hold during which another Talk Hold can extend the same user turn before it is submitted.
_Avoid_: ASR timeout, response delay

**Quiet Companionship**:
A Background Companion Call state in which user-initiated Talk Holds remain available but the character schedules no proactive speech. It may result from an unanswered initiative or an explicit request for silence, with different resume rules.
_Avoid_: Muted call, paused session, disconnected

**Speech Candidate**:
A bounded interval in which microphone audio may be user speech while the character is speaking. It has not yet taken the conversational floor.
_Avoid_: Interruption, barge-in

**Confirmed Interruption**:
A Speech Candidate that has passed the live acoustic and final-ASR gates and has taken the conversational floor from the character.
_Avoid_: Candidate, pause

**Interruption Recovery**:
A single attempt to resume an interrupted character thought after the user took the floor but contributed no usable conversational content and remained silent.
_Avoid_: Retry, rejected candidate recovery

**Audible History**:
The conversation history derived from user turns and character segments known to have completed playback. Generated or transmitted text is not audible merely because it exists.
_Avoid_: Chat history, generated history

## Conversation Direction

**Conversation Move**:
The purpose of the character's next turn: respond, expand, deepen, associate, or recover.
_Avoid_: Intent, prompt kind

**Persona Stance**:
How the character participates in a turn: support, offer an opinion, introduce a gentle contrast, or lead.
_Avoid_: Mood, sentiment

**Reasoning Policy**:
The per-turn choice between a fast response and deliberate reasoning. It is independent of Conversation Move and Persona Stance.
_Avoid_: Thinking mode, depth

**Conversation Depth**:
A bounded description of how much causal, emotional, value, or choice-oriented exploration the current turn warrants. It is semantic, not a count of elapsed turns or reply length.
_Avoid_: Turn count, token budget
