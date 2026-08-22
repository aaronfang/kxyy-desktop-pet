# KXYY Desktop Pet

This context describes the user-visible conversation concepts shared by text chat, realtime voice, persona behavior, and local orchestration.

## Realtime Conversation

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
