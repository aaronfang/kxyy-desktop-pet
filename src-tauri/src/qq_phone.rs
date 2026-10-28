//! Headless QQ audio transport. KoishiRTC remains an external GPL process.
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
type Key = (u32, u32);
struct Segment {
    text: String,
    expected: Option<usize>,
    streaming: bool,
    playback_started: bool,
    received: usize,
    played: usize,
    sequence: u32,
    ended: bool,
}
struct Frame {
    key: Key,
    pcm: Vec<u8>,
}

#[derive(Default)]
struct Relay {
    call_id: Option<String>,
    initial_calls: HashSet<String>,
    users: BTreeMap<u32, String>,
    segments: BTreeMap<Key, Segment>,
    queue: VecDeque<Frame>,
    pending: HashMap<String, (Key, usize, tokio::time::Instant)>,
    paused: bool,
    sequence: u64,
    latest_generation: u32,
    input_sequence: Option<u64>,
    input_tail: Vec<i16>,
    highest_segment: u32,
    provider_pcm: bool,
    session_started: bool,
}
impl Relay {
    fn from_snapshot(value: &Value) -> Result<Self, &'static str> {
        let calls = value["calls"]
            .as_array()
            .filter(|a| a.len() <= 64)
            .ok_or("phone-call-snapshot")?;
        let mut relay = Self::default();
        for call in calls {
            let id = call["id"]
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 1024)
                .ok_or("phone-call-snapshot")?;
            relay.initial_calls.insert(id.into());
        }
        Ok(relay)
    }

    fn reset(&mut self) {
        *self = Self::default();
    }
    fn input(&mut self, v: &Value) -> Result<Vec<u8>, &'static str> {
        if self.call_id.is_none()
            || v["callId"].as_str() != self.call_id.as_deref()
            || v["encoding"] != "pcm_s16le"
            || v["sampleRate"] != 48000
            || v["channels"] != 1
        {
            return Err("phone-input-format");
        }
        let sequence = v["sequence"].as_u64().ok_or("phone-input-format")?;
        if self.input_sequence.is_some_and(|last| sequence <= last) {
            return Err("phone-input-order");
        }
        let encoded = v["data"]
            .as_str()
            .filter(|s| s.len() <= 10240)
            .ok_or("phone-input-format")?;
        let pcm = B64.decode(encoded).map_err(|_| "phone-input-format")?;
        if pcm.is_empty() || pcm.len() % 2 != 0 || pcm.len() > 7680 {
            return Err("phone-input-format");
        }
        self.input_sequence = Some(sequence);
        // A three-sample box filter before 48 -> 16 kHz decimation. Carry is at most two samples.
        self.input_tail.extend(
            pcm.chunks_exact(2)
                .map(|s| i16::from_le_bytes([s[0], s[1]])),
        );
        let mut output = Vec::with_capacity(self.input_tail.len() / 3 * 2);
        for samples in self.input_tail.chunks_exact(3) {
            let mean = samples.iter().map(|n| *n as i32).sum::<i32>() / 3;
            output.extend((mean as i16).to_le_bytes());
        }
        let consumed = self.input_tail.len() / 3 * 3;
        self.input_tail.drain(..consumed);
        Ok(output)
    }

    fn call(&mut self, value: &Value, owner: &str) -> Option<&'static str> {
        let id = value["id"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 1024)?;
        if value["kind"] != "direct"
            || value["direction"] != "incoming"
            || value["state"] != "ringing"
        {
            return None;
        }
        if self.initial_calls.contains(id) || self.call_id.as_deref() == Some(id) {
            return None;
        }
        // The native invitation precedes QQ's asynchronous UID -> QQ-number
        // resolution. Unknown/opaque targets are not evidence of a non-owner;
        // wait for the same invitation's numeric identity update, without
        // allocating a session or issuing an irreversible reject.
        let target = value["targetId"].as_str().filter(|text| {
            (5..=12).contains(&text.len())
                && !text.starts_with('0')
                && text.bytes().all(|c| c.is_ascii_digit())
        })?;
        if target != owner || self.call_id.is_some() {
            return Some("reject");
        }
        self.call_id = Some(id.into());
        Some("accept")
    }
    fn backend(&mut self, v: &Value) -> Result<(), &'static str> {
        match v["type"].as_str().unwrap_or("") {
            "session" if v["state"] == "started" => {
                if self.session_started
                    || v["downlinkAudio"] != "managed-v1"
                    || v["memoryContext"] != "turn-final-v1"
                {
                    return Err("phone-backend-capability");
                }
                self.provider_pcm = match v.get("ttsStream").and_then(Value::as_str) {
                    Some("provider-pcm-v1") => true,
                    Some("none") | None if v.get("ttsStream").is_none_or(|x| x == "none") => false,
                    _ => return Err("phone-backend-capability"),
                };
                self.session_started = true;
            }
            "speech_candidate" => self.paused = true,
            "speech_rejected" => self.paused = false,
            "speech_confirmed" | "assistant_discarded" | "error" => {
                self.queue.clear();
                self.pending.clear();
                self.segments.clear();
                self.paused = false;
            }
            "asr" if v["interim"] == false => {
                let g = id(&v["generation"])?;
                let text = bounded_text(&v["text"], 512)?;
                if g <= self.latest_generation && !self.users.is_empty() {
                    return Err("phone-old-generation");
                }
                self.latest_generation = g;
                self.highest_segment = 0;
                self.users.insert(g, text);
                while self.users.len() > 4 {
                    let first = *self.users.keys().next().unwrap();
                    self.users.remove(&first);
                }
            }
            "audio_segment_start" => {
                let key = (id(&v["generation"])?, id(&v["segmentId"])?);
                let streaming = v["streaming"] == true;
                let expected = if streaming {
                    if !self.provider_pcm || v.get("samples").is_some() {
                        return Err("phone-audio-format");
                    }
                    None
                } else {
                    Some(
                        v["samples"]
                            .as_u64()
                            .filter(|n| *n > 0 && *n <= 24000 * 60)
                            .ok_or("phone-audio-format")? as usize,
                    )
                };
                if key.1 <= self.highest_segment
                    || key.0 != self.latest_generation
                    || !self.users.contains_key(&key.0)
                    || self.segments.len() >= 64
                    || self.segments.contains_key(&key)
                {
                    return Err("phone-segment-order");
                }
                self.highest_segment = key.1;
                self.segments.insert(
                    key,
                    Segment {
                        text: bounded_text(&v["text"], 1000)?,
                        expected,
                        streaming,
                        playback_started: false,
                        received: 0,
                        played: 0,
                        sequence: 0,
                        ended: false,
                    },
                );
            }
            "audio_segment_end" => {
                let key = (id(&v["generation"])?, id(&v["segmentId"])?);
                let segment = self.segments.get_mut(&key).ok_or("phone-unknown-segment")?;
                let expected = if segment.streaming {
                    let samples = v["samples"]
                        .as_u64()
                        .filter(|n| *n > 0 && *n <= 24000 * 60)
                        .ok_or("phone-incomplete-segment")?
                        as usize;
                    if v["status"] != "completed"
                        || v["chunks"].as_u64() != Some(segment.sequence as u64)
                    {
                        return Err("phone-incomplete-segment");
                    }
                    samples
                } else {
                    segment.expected.ok_or("phone-incomplete-segment")?
                };
                if segment.ended
                    || segment.received != expected
                    || v.get("status").is_some_and(|s| s != "completed")
                {
                    return Err("phone-incomplete-segment");
                }
                segment.expected = Some(expected);
                segment.ended = true;
            }
            _ => {}
        }
        Ok(())
    }
    fn pcm(&mut self, data: &[u8]) -> Result<(), &'static str> {
        if data.len() < 26 || &data[..8] != b"KXAU\x01\x00\x00\x18" {
            return Err("phone-audio-format");
        }
        let field = |n| u32::from_be_bytes(data[n..n + 4].try_into().unwrap());
        let key = (field(8), field(12));
        let seq = field(16);
        let samples = field(20) as usize;
        if samples == 0 || samples > 1920 || data.len() != 24 + samples * 2 {
            return Err("phone-audio-format");
        }
        let segment = self.segments.get_mut(&key).ok_or("phone-unknown-segment")?;
        if key.0 != self.latest_generation
            || segment.ended
            || seq != segment.sequence
            || seq >= 750
            || segment.received + samples > segment.expected.unwrap_or(24000 * 60)
            || self.queue.len() + samples.div_ceil(480) > 100
        {
            return Err("phone-audio-order-or-overflow");
        }
        segment.sequence += 1;
        segment.received += samples;
        // 24 -> 48 kHz zero-order hold. No microphone or speaker is opened here.
        for chunk in data[24..].chunks(960) {
            let mut pcm = Vec::with_capacity(chunk.len() * 2);
            for sample in chunk.chunks_exact(2) {
                pcm.extend_from_slice(sample);
                pcm.extend_from_slice(sample);
            }
            self.queue.push_back(Frame { key, pcm });
        }
        Ok(())
    }
    fn next_audio(&mut self) -> Option<Value> {
        if self.call_id.is_none() || self.paused || self.pending.len() >= 8 {
            return None;
        }
        let Some(front) = self.queue.front() else {
            if self.pending.is_empty() {
                for segment in self
                    .segments
                    .values_mut()
                    .filter(|s| s.streaming && !s.ended)
                {
                    segment.playback_started = false;
                }
            }
            return None;
        };
        let key = front.key;
        let segment = self.segments.get_mut(&key)?;
        // Same 240ms startup/rebuffer reservoir as the local Worklet. A shorter
        // completed segment releases immediately; no timer or unbounded queue.
        if segment.streaming && !segment.playback_started && !segment.ended {
            let queued: usize = self
                .queue
                .iter()
                .filter(|f| f.key == key)
                .map(|f| f.pcm.len() / 4)
                .sum();
            if queued < 5760 {
                return None;
            }
        }
        segment.playback_started = true;
        let frame = self.queue.pop_front()?;
        let playback = uuid::Uuid::new_v4().to_string();
        self.pending.insert(
            playback.clone(),
            (frame.key, frame.pcm.len() / 4, tokio::time::Instant::now()),
        );
        let call = self.call_id.as_ref()?;
        let sequence = self.sequence;
        self.sequence += 1;
        Some(request(
            "audio.write",
            json!({"callId":call,"playbackId":playback,"frame":{
            "callId":call,"encoding":"pcm_s16le","sampleRate":48000,"channels":1,"sequence":sequence,
            "timestamp":sequence as f64*20.0,"data":B64.encode(frame.pcm)}}),
        ))
    }
    fn receipt(&mut self, v: &Value) -> Option<(Value, String, String)> {
        if self.call_id.is_none()
            || v["callId"].as_str() != self.call_id.as_deref()
            || !["played", "failed", "cancelled"].contains(&v["state"].as_str().unwrap_or(""))
        {
            return None;
        }
        if let Some((key, samples, _)) = v["id"].as_str().and_then(|id| self.pending.remove(id)) {
            if v["state"] == "played" {
                if let Some(s) = self.segments.get_mut(&key) {
                    s.played += samples;
                }
            } else {
                self.segments.remove(&key);
                self.queue.retain(|frame| frame.key != key);
            }
        }
        self.completed()
    }
    fn playback_expired(&self) -> bool {
        self.pending
            .values()
            .any(|(_, _, at)| at.elapsed() > Duration::from_secs(5))
    }
    fn completed(&mut self) -> Option<(Value, String, String)> {
        if self.paused {
            return None;
        }
        let key = *self
            .segments
            .iter()
            .find(|(_, s)| s.ended && s.expected == Some(s.played))?
            .0;
        let s = self.segments.remove(&key)?;
        Some((
            json!({"type":"playback_segment","generation":key.0,"segmentId":key.1,"state":"completed"}),
            self.users.get(&key.0)?.clone(),
            s.text,
        ))
    }
}
fn id(v: &Value) -> Result<u32, &'static str> {
    v.as_u64()
        .and_then(|n| u32::try_from(n).ok())
        .ok_or("phone-invalid-id")
}
fn bounded_text(v: &Value, max: usize) -> Result<String, &'static str> {
    let s = v
        .as_str()
        .filter(|s| {
            !s.trim().is_empty()
                && s.chars().count() <= max
                && !s.chars().any(|c| c.is_control() && !c.is_whitespace())
        })
        .ok_or("phone-invalid-text")?;
    Ok(s.trim().into())
}
fn request(op: &str, args: Value) -> Value {
    json!({"type":"request","id":uuid::Uuid::new_v4().to_string(),"op":op,"args":args})
}

fn verify_hello(value: &Value, bot: &str) -> Result<(), &'static str> {
    if !["hello", "status"].contains(&value["type"].as_str().unwrap_or(""))
        || value["version"] != 1
        || value["account"]["platform"] != "qq"
        || value["account"]["selfId"].as_str() != Some(bot)
        || value["audioFormat"] != json!({"sampleRate":48000,"channels":1,"encoding":"pcm_s16le"})
    {
        return Err("phone-identity-or-format");
    }
    if ["accept", "reject", "hangup", "receiveAudio", "sendAudio"]
        .iter()
        .any(|key| value["capabilities"][key]["supported"] != true)
    {
        return Err("phone-native-not-ready");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn hello() -> Value {
        json!({"type":"hello","version":1,"account":{"platform":"qq","selfId":"3407404953"},
            "audioFormat":{"sampleRate":48000,"channels":1,"encoding":"pcm_s16le"},
            "capabilities":{"accept":{"supported":true},"reject":{"supported":true},"hangup":{"supported":true},
                "receiveAudio":{"supported":true},"sendAudio":{"supported":true}},"calls":[]})
    }
    #[test]
    fn native_phone_requires_verified_bot_and_two_way_audio_capabilities() {
        assert!(verify_hello(&hello(), "3407404953").is_ok());
        assert!(verify_hello(&hello(), "37615985").is_err());
        for capability in ["accept", "reject", "hangup", "receiveAudio", "sendAudio"] {
            let mut value = hello();
            value["capabilities"][capability]["supported"] = json!(false);
            assert!(verify_hello(&value, "3407404953").is_err());
        }
        let mut value = hello();
        value["audioFormat"]["sampleRate"] = json!(24000);
        assert!(verify_hello(&value, "3407404953").is_err());
    }
    #[test]
    fn phone_accepts_only_a_fresh_owner_direct_invitation_and_never_adopts_an_existing_call() {
        let mut relay = Relay::default();
        let mut call = json!({"id":"boot:1","kind":"direct","direction":"incoming","targetId":"37615985","state":"ringing"});
        call["targetId"] = json!("12345678");
        assert_eq!(relay.call(&call, "37615985"), Some("reject"));
        assert!(relay.call_id.is_none());
        call["targetId"] = json!("37615985");
        call["kind"] = json!("group");
        assert_eq!(relay.call(&call, "37615985"), None);
        call["kind"] = json!("direct");
        call["state"] = json!("connected");
        assert_eq!(relay.call(&call, "37615985"), None);
        call["state"] = json!("ringing");
        assert_eq!(relay.call(&call, "37615985"), Some("accept"));
        assert_eq!(relay.call(&call, "37615985"), None);
        call["id"] = json!("boot:2");
        assert_eq!(relay.call(&call, "37615985"), Some("reject"));
    }
    #[test]
    fn unresolved_incoming_identity_waits_for_owner_resolution_without_rejecting_or_starting_a_session(
    ) {
        let mut relay = Relay::default();
        let mut call =
            json!({"id":"fresh","kind":"direct","direction":"incoming","state":"ringing"});
        for target in [
            Value::Null,
            json!("unknown"),
            json!("u_opaque-native-id"),
            json!(""),
            json!("37615985x"),
            json!("376159850000000000000"),
        ] {
            call["targetId"] = target;
            assert_eq!(
                relay.call(&call, "37615985"),
                None,
                "unresolved identity cannot be accepted or rejected"
            );
            assert!(relay.call_id.is_none());
        }
        call["targetId"] = json!("37615985");
        assert_eq!(relay.call(&call, "37615985"), Some("accept"));
        assert_eq!(
            relay.call(&call, "37615985"),
            None,
            "duplicate identity update must not accept twice"
        );
        call["id"] = json!("foreign");
        call["targetId"] = json!("12345678");
        assert_eq!(relay.call(&call, "37615985"), Some("reject"));
    }
    #[test]
    fn reconnect_does_not_accept_ringing_calls_from_the_initial_snapshot() {
        let call = json!({"id":"old-call","kind":"direct","direction":"incoming","targetId":"37615985","state":"ringing"});
        let mut r = Relay::from_snapshot(&json!({"calls":[call.clone()]})).unwrap();
        assert_eq!(r.call(&call, "37615985"), None);
        let mut fresh = call;
        fresh["id"] = json!("new-call");
        assert_eq!(r.call(&fresh, "37615985"), Some("accept"));
        assert!(Relay::from_snapshot(&json!({"calls":vec![json!({"id":"x"});65]})).is_err());
    }
    #[test]
    fn incoming_audio_is_call_bound_ordered_and_downsampled_without_truncation() {
        let mut r = Relay::default();
        r.call_id = Some("call".into());
        let frame = |call, seq, bytes: Vec<u8>| json!({"callId":call,"encoding":"pcm_s16le","sampleRate":48000,"channels":1,"sequence":seq,"timestamp":0,"data":B64.encode(bytes)});
        assert!(r.input(&frame("old", 0, vec![0; 6])).is_err());
        assert_eq!(
            r.input(&frame("call", 0, vec![3, 0, 6, 0])).unwrap(),
            Vec::<u8>::new()
        );
        assert_eq!(
            r.input(&frame("call", 1, vec![9, 0, 12, 0, 15, 0, 18, 0]))
                .unwrap(),
            vec![6, 0, 15, 0]
        );
        assert!(r.input(&frame("call", 1, vec![0; 6])).is_err());
        r.reset();
        assert!(r.call_id.is_none());
        assert!(r.input(&frame("call", 2, vec![0; 6])).is_err());
    }
    pub(super) fn packet(g: u32, s: u32, seq: u32, samples: usize) -> Vec<u8> {
        let mut b = b"KXAU\x01\x00\x00\x18".to_vec();
        for n in [g, s, seq, samples as u32] {
            b.extend(n.to_be_bytes());
        }
        b.extend(vec![0x01; samples * 2]);
        b
    }
    #[test]
    fn streamed_speech_can_play_before_final_length_but_only_complete_evidence_enters_memory() {
        let mut r = Relay::default();
        r.call_id = Some("call".into());
        // This test emulates the negotiated provider-pcm-v1 session.
        r.backend(&json!({"type":"session","state":"started","downlinkAudio":"managed-v1","memoryContext":"turn-final-v1","ttsStream":"provider-pcm-v1"})).unwrap();
        r.backend(&json!({"type":"asr","interim":false,"generation":1,"text":"你好"}))
            .unwrap();
        r.backend(&json!({"type":"audio_segment_start","generation":1,"segmentId":1,"streaming":true,"text":"你好，元宝"})).unwrap();
        for seq in 0..3 {
            r.pcm(&packet(1, 1, seq, 1920)).unwrap();
        }
        let mut frames = Vec::new();
        while let Some(frame) = r.next_audio() {
            assert!(
                r.receipt(
                    &json!({"callId":"call","id":frame["args"]["playbackId"],"state":"played"})
                )
                .is_none(),
                "early played chunks are not a complete segment"
            );
            frames.push(frame);
        }
        assert_eq!(
            frames.len(),
            12,
            "start after 240ms without waiting for synthesis completion"
        );
        assert!(r.completed().is_none());
        r.pcm(&packet(1, 1, 3, 480)).unwrap();
        r.backend(&json!({"type":"audio_segment_end","generation":1,"segmentId":1,"status":"completed","samples":6240,"chunks":4})).unwrap();
        let tail = r.next_audio().unwrap();
        let evidence = r
            .receipt(&json!({"callId":"call","id":tail["args"]["playbackId"],"state":"played"}))
            .unwrap();
        assert_eq!(evidence.0["state"], "completed");
        assert_eq!(evidence.2, "你好，元宝");
        assert!(r.completed().is_none(), "idempotent completion");
    }
    fn streaming_relay() -> Relay {
        let mut relay = Relay::default();
        relay.call_id = Some("call".into());
        relay.backend(&json!({"type":"session","state":"started","downlinkAudio":"managed-v1","memoryContext":"turn-final-v1","ttsStream":"provider-pcm-v1"})).unwrap();
        relay
            .backend(&json!({"type":"asr","interim":false,"generation":1,"text":"你好"}))
            .unwrap();
        relay.backend(&json!({"type":"audio_segment_start","generation":1,"segmentId":1,"streaming":true,"text":"你好，元宝"})).unwrap();
        relay
    }
    #[test]
    fn streaming_startup_and_rebuffer_are_bounded_and_completed_short_segments_release_immediately()
    {
        let mut relay = streaming_relay();
        for seq in 0..2 {
            relay.pcm(&packet(1, 1, seq, 1920)).unwrap();
            assert!(
                relay.next_audio().is_none(),
                "do not play before 240ms reservoir"
            );
        }
        relay.pcm(&packet(1, 1, 2, 1920)).unwrap();
        for _ in 0..12 {
            let frame = relay.next_audio().unwrap();
            assert!(relay
                .receipt(
                    &json!({"callId":"call","id":frame["args"]["playbackId"],"state":"played"})
                )
                .is_none());
        }
        assert!(relay.next_audio().is_none());
        relay.pcm(&packet(1, 1, 3, 480)).unwrap();
        assert!(
            relay.next_audio().is_none(),
            "after a drain rebuffer instead of playing 20ms bursts"
        );
        relay.backend(&json!({"type":"audio_segment_end","generation":1,"segmentId":1,"status":"completed","samples":6240,"chunks":4})).unwrap();
        assert!(
            relay.next_audio().is_some(),
            "known short tail releases without a timer"
        );
        let mut short = streaming_relay();
        short.pcm(&packet(1, 1, 0, 1)).unwrap();
        assert!(short.next_audio().is_none());
        short.backend(&json!({"type":"audio_segment_end","generation":1,"segmentId":1,"status":"completed","samples":1,"chunks":1})).unwrap();
        assert!(short.next_audio().is_some());
    }
    #[test]
    fn malformed_failed_and_cancelled_streams_never_complete_or_bypass_negotiation_and_limits() {
        let end = json!({"type":"audio_segment_end","generation":1,"segmentId":1,"status":"completed","samples":480,"chunks":1});
        for change in [
            json!({"status":"failed"}),
            json!({"status":"cancelled"}),
            json!({"status":null}),
            json!({"samples":479}),
            json!({"samples":0}),
            json!({"samples":1440001}),
            json!({"chunks":0}),
            json!({"chunks":2}),
            json!({"chunks":null}),
        ] {
            let mut relay = streaming_relay();
            relay.pcm(&packet(1, 1, 0, 480)).unwrap();
            let mut invalid = end.clone();
            for (key, value) in change.as_object().unwrap() {
                invalid[key] = value.clone();
            }
            assert!(relay.backend(&invalid).is_err());
            assert!(relay.completed().is_none());
        }
        for event in ["speech_confirmed", "assistant_discarded", "error"] {
            let mut relay = streaming_relay();
            for seq in 0..3 {
                relay.pcm(&packet(1, 1, seq, 1920)).unwrap();
            }
            let frame = relay.next_audio().unwrap();
            relay.backend(&json!({"type":event})).unwrap();
            assert!(relay
                .receipt(
                    &json!({"callId":"call","id":frame["args"]["playbackId"],"state":"played"})
                )
                .is_none());
            assert!(relay.next_audio().is_none());
            assert!(relay.completed().is_none());
        }
        let mut relay = Relay::default();
        relay
            .backend(&json!({"type":"asr","interim":false,"generation":1,"text":"你好"}))
            .unwrap();
        assert!(relay.backend(&json!({"type":"audio_segment_start","generation":1,"segmentId":1,"streaming":true,"text":"你好"})).is_err());
        let mut relay = streaming_relay();
        for seq in 0..25 {
            relay.pcm(&packet(1, 1, seq, 1920)).unwrap();
        }
        assert!(
            relay.pcm(&packet(1, 1, 25, 1)).is_err(),
            "2s queue is unchanged"
        );
        let mut relay = streaming_relay();
        for seq in 0..750 {
            relay.pcm(&packet(1, 1, seq, 1920)).unwrap();
            if seq % 3 == 2 {
                for _ in 0..12 {
                    let frame = relay.next_audio().unwrap();
                    assert!(relay.receipt(&json!({"callId":"call","id":frame["args"]["playbackId"],"state":"played"})).is_none());
                }
            }
        }
        assert!(
            relay.pcm(&packet(1, 1, 750, 1)).is_err(),
            "750 chunks / 60s ceiling is unchanged"
        );
        assert!(relay.completed().is_none());
    }
    #[test]
    fn interruption_failure_and_overflow_cannot_promote_unplayed_speech_to_memory() {
        for outcome in ["speech_confirmed", "assistant_discarded", "error"] {
            let mut r = Relay::default();
            r.call_id = Some("call".into());
            r.backend(&json!({"type":"asr","interim":false,"generation":1,"text":"我喜欢乌龙茶"}))
                .unwrap();
            r.backend(&json!({"type":"audio_segment_start","generation":1,"segmentId":1,"samples":480,"text":"好的"})).unwrap();
            r.pcm(&packet(1, 1, 0, 480)).unwrap();
            let a = r.next_audio().unwrap();
            r.backend(&json!({"type":outcome})).unwrap();
            assert!(r
                .receipt(&json!({"callId":"call","id":a["args"]["playbackId"],"state":"played"}))
                .is_none());
            assert!(r.next_audio().is_none());
            assert!(r.completed().is_none());
            assert!(r.backend(&json!({"type":"audio_segment_start","generation":1,"segmentId":1,"samples":480,"text":"旧片段"})).is_err());
        }
        for state in ["failed", "cancelled"] {
            let mut r = Relay::default();
            r.call_id = Some("call".into());
            r.backend(&json!({"type":"asr","interim":false,"generation":1,"text":"我喜欢乌龙茶"}))
                .unwrap();
            r.backend(&json!({"type":"audio_segment_start","generation":1,"segmentId":1,"samples":480,"text":"好的"})).unwrap();
            r.pcm(&packet(1, 1, 0, 480)).unwrap();
            let a = r.next_audio().unwrap();
            r.backend(&json!({"type":"audio_segment_end","generation":1,"segmentId":1}))
                .unwrap();
            assert!(r
                .receipt(&json!({"callId":"call","id":a["args"]["playbackId"],"state":state}))
                .is_none());
            assert!(r.completed().is_none());
        }
        let mut r = Relay::default();
        r.call_id = Some("call".into());
        r.backend(&json!({"type":"asr","interim":false,"generation":1,"text":"你好"}))
            .unwrap();
        r.backend(&json!({"type":"audio_segment_start","generation":1,"segmentId":1,"samples":48480,"text":"你好"})).unwrap();
        for n in 0..25 {
            r.pcm(&packet(1, 1, n, 1920)).unwrap();
        }
        assert!(r.pcm(&packet(1, 1, 25, 480)).is_err());
        r.backend(&json!({"type":"speech_candidate"})).unwrap();
        assert!(r.next_audio().is_none());
        r.backend(&json!({"type":"speech_rejected"})).unwrap();
        assert!(r.next_audio().is_some());
        for (_, _, at) in r.pending.values_mut() {
            *at = tokio::time::Instant::now() - Duration::from_secs(6);
        }
        assert!(r.playback_expired());
        assert!(r.completed().is_none());
    }
    #[test]
    fn memory_waits_for_every_played_frame_and_validated_segment_end() {
        let mut r = Relay::default();
        r.call_id = Some("call".into());
        r.backend(&json!({"type":"asr","interim":false,"generation":7,"text":"我喜欢乌龙茶"}))
            .unwrap();
        r.backend(&json!({"type":"audio_segment_start","generation":7,"segmentId":1,"samples":960,"text":"好的，元宝"})).unwrap();
        r.pcm(&packet(7, 1, 0, 960)).unwrap();
        let a = r.next_audio().expect("first 20ms");
        let b = r.next_audio().expect("second 20ms");
        let ack =
            |v: &Value| json!({"callId":"call","id":v["args"]["playbackId"],"state":"played"});
        assert!(r.receipt(&ack(&a)).is_none());
        assert!(r.receipt(&ack(&b)).is_none());
        r.backend(&json!({"type":"audio_segment_end","generation":7,"segmentId":1}))
            .unwrap();
        // A later duplicate receipt may release only the once-complete segment.
        let (receipt, user, spoken) = r.receipt(&ack(&b)).expect("completed playback");
        assert_eq!(
            receipt,
            json!({"type":"playback_segment","generation":7,"segmentId":1,"state":"completed"})
        );
        assert_eq!(user, "我喜欢乌龙茶");
        assert_eq!(spoken, "好的，元宝");
        assert!(r.receipt(&ack(&b)).is_none());
    }
}

use futures_util::{SinkExt, StreamExt};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;
use tokio_tungstenite::{
    tungstenite::{client::IntoClientRequest, Message},
    MaybeTlsStream, WebSocketStream,
};
type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

#[derive(Default)]
pub(crate) struct PhoneState {
    revision: AtomicU64,
    active: AtomicBool,
    launched: AtomicBool,
    status: Mutex<String>,
    prompt: Mutex<Option<(String, oneshot::Sender<(String, String)>)>>,
    host: crate::qq_service::Service,
    daemon: crate::qq_service::Service,
    token: Mutex<String>,
    bot: Mutex<String>,
    launcher: Mutex<Option<crate::qq_service::PhoneLauncher>>,
    audio: Mutex<Option<crate::qq_audio::Lease>>,
}
impl PhoneState {
    pub(crate) fn status(&self) -> String {
        let s = self.status.lock().unwrap();
        if s.is_empty() {
            "disabled".into()
        } else {
            s.clone()
        }
    }
    pub(crate) fn set_status(&self, app: &AppHandle, s: &str) {
        *self.status.lock().unwrap() = s.into();
        let _ = app.emit(
            "qq-phone-status",
            json!({"active":self.active.load(Ordering::SeqCst),"state":s}),
        );
    }
    pub(crate) fn running(&self) -> bool {
        self.launched.load(Ordering::SeqCst)
    }
    pub(crate) fn invalidate(&self) {
        self.revision.fetch_add(1, Ordering::SeqCst);
        self.prompt.lock().unwrap().take();
    }
    pub(crate) fn stop(&self) {
        self.invalidate();
        let _ = self.daemon.stop();
        let _ = self.host.stop();
        self.launcher.lock().unwrap().take();
        self.audio.lock().unwrap().take();
        self.launched.store(false, Ordering::SeqCst);
        self.active.store(false, Ordering::SeqCst);
        self.token.lock().unwrap().clear();
        *self.status.lock().unwrap() = "disabled".into();
    }
    pub(crate) fn launch(
        &self,
        app: &AppHandle,
        cfg: &crate::qq::Config,
        qq: &crate::qq_service::Service,
    ) -> Result<(), String> {
        if self.running() {
            if *self.bot.lock().unwrap() == cfg.bot_id
                && self.host.is_alive()
                && self.daemon.is_alive()
                && qq.is_alive()
            {
                return Ok(());
            }
            qq.stop()?;
            self.stop();
        }
        let Some((root, python, node)) = runtime_paths() else {
            return Err("phone-setup-required".into());
        };
        // Files and audio drivers must already be explicitly installed. No runtime installer or privilege prompt.
        let dir = app
            .path()
            .app_config_dir()
            .map_err(|_| "phone-setup-required")?
            .join("qq-phone");
        std::fs::create_dir_all(&dir).map_err(|_| "phone-setup-required")?;
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let token_path = dir.join("daemon.token");
        private_write(&token_path, token.as_bytes())?;
        let device = |name: &str| {
            use base64::engine::general_purpose::URL_SAFE_NO_PAD;
            format!(
                "pa:{}",
                URL_SAFE_NO_PAD.encode(json!(["Core Audio", name]).to_string())
            )
        };
        let config = json!({"host":"127.0.0.1","port":6120,"tokenFile":token_path,
            "account":{"platform":"qq","selfId":cfg.bot_id},
            "qq":{"url":"http://127.0.0.1:6110","tokenFile":root.join("runtime/control.token")},
            "audio":{"backend":"portaudio","python":python,"inputDevice":device("BlackHole 16ch"),"outputDevice":device("BlackHole 2ch"),
                "sampleRate":48000,"channels":1,"frameMs":20,"maxQueueMs":2000}});
        let config_path = dir.join("bridge.json");
        private_write(
            &config_path,
            &serde_json::to_vec(&config).map_err(|_| "phone-setup-required")?,
        )?;
        qq.stop()?;
        self.stop();
        let documents = root.parent().ok_or("phone-setup-required")?;
        crate::qq_service::validate_install(
            std::path::Path::new("/Applications/QQ.app/Contents/Resources/app"),
            documents,
        )
        .map_err(|_| "phone-setup-required")?;
        let launcher = crate::qq_service::prepare_phone_launcher(documents)?;
        let audio = crate::qq_audio::Lease::acquire().map_err(str::to_string)?;
        let result = (|| {
            self.host.start_phone_host(&root, &cfg.bot_id)?;
            qq.start_phone(&root, &cfg.bot_id, &self.host)?;
            let mut daemon = std::process::Command::new(node);
            daemon.arg(root.join("bridge/daemon.mjs")).arg(config_path);
            self.daemon.start_command(daemon)?;
            Ok::<_, String>(())
        })();
        if let Err(reason) = result {
            let _ = qq.stop();
            self.stop();
            return Err(if reason == "phone-external-qq" {
                reason
            } else {
                "phone-connection-failed".into()
            });
        }
        *self.launcher.lock().unwrap() = Some(launcher);
        *self.audio.lock().unwrap() = Some(audio);
        *self.token.lock().unwrap() = token;
        *self.bot.lock().unwrap() = cfg.bot_id.clone();
        self.launched.store(true, Ordering::SeqCst);
        self.set_status(app, "connecting");
        Ok(())
    }
}
fn runtime_paths() -> Option<(PathBuf, PathBuf, PathBuf)> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let root = PathBuf::from(std::env::var_os("HOME")?)
        .join("Library/Containers/com.tencent.qq/Data/Documents/KxyyRTCQQ");
    let python = root.join("runtime/audio-venv/bin/python3");
    let node = [
        "/opt/homebrew/bin/node",
        "/opt/homebrew/opt/node@24/bin/node",
        "/usr/local/bin/node",
    ]
    .into_iter()
    .map(PathBuf::from)
    .find(|p| p.is_file())?;
    for p in [
        root.join("bridge/qq/macos/host.cjs"),
        root.join("napcat/koishi-rtc-loader.cjs"),
        root.join("runtime/control.token"),
        root.join("bridge/daemon.mjs"),
        root.join("node_modules/ws/package.json"),
        root.join("runtime/kxyy-audio-profile-v2"),
        python.clone(),
        PathBuf::from("/Library/Audio/Plug-Ins/HAL/BlackHole2ch.driver"),
        PathBuf::from("/Library/Audio/Plug-Ins/HAL/BlackHole16ch.driver"),
    ] {
        if !p.exists() {
            return None;
        }
    }
    // This optional NapCat native packet hook patches signed pages and was
    // confirmed to SIGKILL the QQ worker on this macOS/arm64 runtime.
    if root
        .join("napcat/native/packet/MoeHoo.darwin.arm64.node")
        .exists()
    {
        return None;
    }
    Some((root, python, node))
}
fn private_write(path: &std::path::Path, data: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .and_then(|mut f| f.write_all(data))
        .map_err(|_| "phone-setup-required".into())
}
#[tauri::command]
pub(crate) fn qq_phone_persona(
    app: AppHandle,
    nonce: String,
    system_role: String,
    bot_name: String,
) -> Result<(), String> {
    if system_role.trim().is_empty()
        || system_role.len() > 65536
        || bot_name.trim().is_empty()
        || bot_name.chars().count() > 80
    {
        return Err("phone-persona-invalid".into());
    }
    let state = app.state::<crate::qq::QqState>();
    let mut prompt = state.phone.prompt.lock().unwrap();
    if prompt.as_ref().is_some_and(|(n, _)| *n == nonce) {
        if let Some((_, sender)) = prompt.take() {
            let _ = sender.send((system_role, bot_name));
        }
        Ok(())
    } else {
        Err("phone-persona-stale".into())
    }
}
async fn send(socket: &mut Socket, value: Value) -> Result<(), &'static str> {
    send_message(socket, Message::Text(value.to_string())).await
}
async fn send_message(socket: &mut Socket, message: Message) -> Result<(), &'static str> {
    tokio::time::timeout(Duration::from_secs(2), socket.send(message))
        .await
        .map_err(|_| "phone-write-timeout")?
        .map_err(|_| "phone-disconnected")
}
async fn next_json(socket: &mut Socket) -> Result<Value, &'static str> {
    match tokio::time::timeout(Duration::from_secs(5), socket.next()).await {
        Ok(Some(Ok(Message::Text(raw)))) if raw.len() <= 512 * 1024 => {
            serde_json::from_str(&raw).map_err(|_| "phone-protocol")
        }
        _ => Err("phone-handshake"),
    }
}
async fn start_backend(
    socket: &mut Socket,
    role: &str,
    name: &str,
    relay: &mut Relay,
) -> Result<(), &'static str> {
    send(socket,json!({"type":"start","systemRole":role,"botName":name,"downlinkAudio":["managed-v1"],"ttsStream":["provider-pcm-v1"],"memoryContext":["turn-final-v1"]})).await?;
    let session = next_json(socket).await?;
    if session["type"] != "session" || session["state"] != "started" {
        return Err("phone-backend-capability");
    }
    relay.backend(&session)
}
async fn daemon_connect(token: &str) -> Result<Socket, &'static str> {
    let mut request = "ws://127.0.0.1:6120/v1/stream"
        .into_client_request()
        .map_err(|_| "phone-connect")?;
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {token}")
            .parse()
            .map_err(|_| "phone-connect")?,
    );
    let mut config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default();
    config.max_message_size = Some(512 * 1024);
    config.max_frame_size = Some(512 * 1024);
    tokio::time::timeout(
        Duration::from_secs(5),
        tokio_tungstenite::connect_async_with_config(request, Some(config), true),
    )
    .await
    .map_err(|_| "phone-connect")?
    .map(|(s, _)| s)
    .map_err(|_| "phone-connect")
}
pub(crate) fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let state = app.state::<crate::qq::QqState>();
            if let Some(cfg) = state.phone_config().filter(|_| state.phone.running()) {
                let token = state.phone.token.lock().unwrap().clone();
                match daemon_connect(&token).await {
                    Ok(mut socket) => {
                        let ready = next_json(&mut socket).await.and_then(|v| {
                            verify_hello(&v, &cfg.bot_id)?;
                            Relay::from_snapshot(&v)
                        });
                        match ready {
                            Ok(relay) => {
                                state.phone.set_status(&app, "ready");
                                if run(&app, &cfg, &mut socket, relay).await.is_err()
                                    && state.phone.running()
                                {
                                    state.phone.set_status(&app, "phone-session-failed");
                                }
                            }
                            Err(_) => state.phone.set_status(&app, "phone-native-not-ready"),
                        }
                        let _ =
                            tokio::time::timeout(Duration::from_millis(500), socket.close(None))
                                .await;
                    }
                    Err(_) => state.phone.set_status(&app, "phone-connection-failed"),
                }
            }
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    });
}

async fn run(
    app: &AppHandle,
    cfg: &crate::qq::Config,
    daemon: &mut Socket,
    mut relay: Relay,
) -> Result<(), &'static str> {
    let state = app.state::<crate::qq::QqState>();
    let revision = state.phone.revision.load(Ordering::SeqCst);
    let mut poll = tokio::time::interval(Duration::from_millis(100));
    loop {
        tokio::select! {
            _=poll.tick()=>{
                if state.phone.revision.load(Ordering::SeqCst)!=revision || state.phone_config().is_none() {return Ok(());}
            },
            message=daemon.next()=>{
                match message {
                    Some(Ok(Message::Ping(data)))=>send_message(daemon,Message::Pong(data)).await?,
                    Some(Ok(Message::Text(raw))) if raw.len()<=512*1024=>{
                        let v:Value=serde_json::from_str(&raw).map_err(|_|"phone-protocol")?;
                        match v["type"].as_str().unwrap_or("") {
                            "status"|"hello"=>verify_hello(&v,&cfg.bot_id)?,
                            "call"=>{
                                let call=&v["call"];
                                if let Some(op)=relay.call(call,&cfg.owner_id) {
                                    if op=="reject" {send(daemon,request("reject",json!({"callId":call["id"]}))).await?;continue;}
                                    state.phone.active.store(true,Ordering::SeqCst);state.phone.set_status(app,"ringing");
                                    let result=call_session(app,cfg,daemon,&mut relay,revision).await;
                                    if let Some(id)=relay.call_id.as_ref() {let _=send(daemon,request("audio.clear",json!({"callId":id}))).await;let _=send(daemon,request("hangup",json!({"callId":id}))).await;}
                                    relay.reset();state.phone.prompt.lock().unwrap().take();state.phone.active.store(false,Ordering::SeqCst);
                                    state.phone.set_status(app,match result {Ok(())=>"phone-ended",Err("phone-backend-unavailable")=>"phone-backend-unavailable",Err(_)=>"phone-session-failed"});
                                    // Reconnect after every call so no old control/audio/receipt can enter the next one.
                                    return result;
                                }
                            },
                            "error"=>return Err("phone-native-not-ready"),_=>{}
                        }
                    },_=>return Err("phone-disconnected"),
                }
            }
        }
    }
}
async fn call_session(
    app: &AppHandle,
    cfg: &crate::qq::Config,
    daemon: &mut Socket,
    relay: &mut Relay,
    revision: u64,
) -> Result<(), &'static str> {
    let state = app.state::<crate::qq::QqState>();
    let settings = app
        .state::<crate::AppState>()
        .settings
        .lock()
        .unwrap()
        .clone();
    if !["local", "voxcpm", "cosyvoice"].contains(&settings.realtime_backend.as_str()) {
        return Err("phone-backend-unavailable");
    }
    let port = crate::voice_service::port_for(&settings.realtime_backend);
    let healthy =
        tauri::async_runtime::spawn_blocking(move || crate::voice_service::service_running(port))
            .await
            .unwrap_or(false);
    if !healthy {
        return Err("phone-backend-unavailable");
    }
    let memory = app.state::<crate::memory::MemoryState>();
    let lease = crate::memory::with_qq_memory_lease(&memory, None, |lease| lease)
        .ok_or("phone-memory-unavailable")?;
    let nonce = uuid::Uuid::new_v4().to_string();
    let (sender, receiver) = oneshot::channel();
    *state.phone.prompt.lock().unwrap() = Some((nonce.clone(), sender));
    app.emit(
        "qq-phone-persona-request",
        json!({"nonce":nonce,"cardId":cfg.card_id,"nickname":cfg.nickname}),
    )
    .map_err(|_| "phone-persona-unavailable")?;
    let (system_role, bot_name) = tokio::time::timeout(Duration::from_secs(5), receiver)
        .await
        .map_err(|_| "phone-persona-unavailable")?
        .map_err(|_| "phone-persona-unavailable")?;
    if state.phone.revision.load(Ordering::SeqCst) != revision {
        return Err("phone-cancelled");
    }
    let mut config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default();
    config.max_message_size = Some(128 * 1024);
    config.max_frame_size = Some(128 * 1024);
    let (mut backend, _) = tokio::time::timeout(
        Duration::from_secs(5),
        tokio_tungstenite::connect_async_with_config(
            format!("ws://127.0.0.1:{port}"),
            Some(config),
            true,
        ),
    )
    .await
    .map_err(|_| "phone-backend-unavailable")?
    .map_err(|_| "phone-backend-unavailable")?;
    start_backend(&mut backend, &system_role, &bot_name, relay).await?;
    let call_id = relay.call_id.clone().ok_or("phone-call-missing")?;
    send(daemon, request("accept", json!({"callId":call_id}))).await?;
    let context = AppCallContext {
        app,
        cfg,
        revision,
        lease: &lease,
        session: uuid::Uuid::new_v4().to_string(),
    };
    let result = relay_session(
        &context,
        &cfg.bot_id,
        &cfg.owner_id,
        daemon,
        &mut backend,
        relay,
    )
    .await;
    let _ = send(&mut backend, json!({"type":"stop"})).await;
    let _ = tokio::time::timeout(Duration::from_millis(500), backend.close(None)).await;
    result
}
trait CallContext {
    fn current(&self) -> bool;
    fn connected(&self);
    fn recall(&self, query: &str) -> Result<Vec<Value>, &'static str>;
    fn remember(&self, evidence: (Value, String, String));
}
struct AppCallContext<'a> {
    app: &'a AppHandle,
    cfg: &'a crate::qq::Config,
    revision: u64,
    lease: &'a str,
    session: String,
}
impl CallContext for AppCallContext<'_> {
    fn current(&self) -> bool {
        let s = self.app.state::<crate::qq::QqState>();
        s.phone.revision.load(Ordering::SeqCst) == self.revision && s.phone_config().is_some()
    }
    fn connected(&self) {
        self.app
            .state::<crate::qq::QqState>()
            .phone
            .set_status(self.app, "active");
    }
    fn recall(&self, query: &str) -> Result<Vec<Value>, &'static str> {
        if !self.current() {
            return Err("phone-cancelled");
        }
        let memory = self.app.state::<crate::memory::MemoryState>();
        crate::memory::with_qq_memory_db(&memory,Some(self.lease),|conn,_| {
            crate::memory::recall_memory(conn,&crate::memory::MemoryRecallRequest {card_id:self.cfg.card_id.clone(),nickname:self.cfg.nickname.clone(),query:query.into(),reason:"turn".into(),image_caption:String::new(),max_items:Some(6)})
                .map(|r|r.items.into_iter().map(|i|json!({"kind":i.kind,"text":i.text,"pinned":i.pinned,"uncertain":i.uncertain})).collect::<Vec<_>>()).unwrap_or_default()
        }).ok_or("phone-memory-invalidated")
    }
    fn remember(&self, evidence: (Value, String, String)) {
        let memory = self.app.state::<crate::memory::MemoryState>();
        let _ = crate::memory::with_qq_memory_db(&memory, Some(self.lease), |conn, _| {
            if self.current() {
                let _ = enqueue_spoken(
                    conn,
                    self.cfg,
                    &self.session,
                    &evidence.0,
                    evidence.1,
                    evidence.2,
                    || crate::memory::trigger_worker(self.app),
                );
            }
        });
    }
}
async fn relay_session<C: CallContext>(
    context: &C,
    bot: &str,
    owner: &str,
    daemon: &mut Socket,
    backend: &mut Socket,
    relay: &mut Relay,
) -> Result<(), &'static str> {
    let mut tick = tokio::time::interval(Duration::from_millis(20));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let started = tokio::time::Instant::now();
    let mut connected = false;
    loop {
        tokio::select! {
            _=tick.tick()=>{
                if !context.current() {return Err("phone-cancelled");}
                if !connected && started.elapsed()>Duration::from_secs(20) {return Err("phone-answer-timeout");}
                if started.elapsed()>Duration::from_secs(7200) {return Ok(());}
                if relay.playback_expired() {return Err("phone-playback-timeout");}
                if connected {if let Some(frame)=relay.next_audio() {send(daemon,frame).await?;}}
            },
            message=daemon.next()=>match message {
                Some(Ok(Message::Ping(data)))=>send_message(daemon,Message::Pong(data)).await?,
                Some(Ok(Message::Text(raw))) if raw.len()<=512*1024=>{
                    let v:Value=serde_json::from_str(&raw).map_err(|_|"phone-protocol")?;
                    match v["type"].as_str().unwrap_or("") {
                        "status"|"hello"=>verify_hello(&v,bot)?,
                        "call"=>{
                            let call=&v["call"];
                            if call["id"].as_str()==relay.call_id.as_deref() {
                                if ["ended","failed"].contains(&call["state"].as_str().unwrap_or("")) {return Ok(());}
                                if call["state"]=="connected" {connected=true;context.connected();}
                            }else if relay.call(call,owner)==Some("reject") {send(daemon,request("reject",json!({"callId":call["id"]}))).await?;}
                        },
                        "audio" if connected=>{let pcm=relay.input(&v["frame"])?;if !pcm.is_empty(){send_message(backend,Message::Binary(pcm)).await?;}},
                        "playback"=>{if let Some(completed)=relay.receipt(&v["receipt"]){complete(context,backend,completed).await?;}},
                        "reply"=>{
                            if v["ok"]==false {return Err("phone-control-failed");}
                            if let Some(completed)=relay.receipt(&v["data"]){complete(context,backend,completed).await?;}
                        },
                        "error"=>return Err("phone-audio-failed"),_=>{}
                    }
                },_=>return Err("phone-disconnected"),
            },
            message=backend.next()=>match message {
                Some(Ok(Message::Ping(data)))=>send_message(backend,Message::Pong(data)).await?,
                Some(Ok(Message::Binary(data)))=>relay.pcm(&data)?,
                Some(Ok(Message::Text(raw))) if raw.len()<=128*1024=>{
                    let v:Value=serde_json::from_str(&raw).map_err(|_|"phone-protocol")?;
                    relay.backend(&v)?;
                    match v["type"].as_str().unwrap_or("") {
                        "speech_confirmed"|"assistant_discarded"|"error"=>{
                            send(daemon,request("audio.clear",json!({"callId":relay.call_id}))).await?;
                            send(backend,json!({"type":"playback_reset"})).await?;
                        },
                        "memory_context_request"=>{
                            let generation=id(&v["generation"])?;
                            let query=relay.users.get(&generation).ok_or("phone-memory-generation")?;
                            let items=context.recall(query)?;
                            send(backend,json!({"type":"memory_context","generation":generation,"items":items})).await?;
                        },"session" if v["state"]=="ended"=>return Ok(()),_=>{}
                    }
                },_=>return Err("phone-backend-disconnected"),
            }
        }
        while let Some(completed) = relay.completed() {
            complete(context, backend, completed).await?;
        }
    }
}
fn enqueue_spoken(
    conn: &mut rusqlite::Connection,
    cfg: &crate::qq::Config,
    session: &str,
    receipt: &Value,
    user: String,
    spoken: String,
    wake_worker: impl FnOnce(),
) -> Result<crate::memory::MemoryEnqueueResponse, String> {
    let identity = format!(
        "{session}:{}:{}",
        receipt["generation"], receipt["segmentId"]
    );
    let result = crate::memory::enqueue_qq_exchange(
        conn,
        crate::memory::MemoryEnqueueRequest {
            card_id: cfg.card_id.clone(),
            nickname: cfg.nickname.clone(),
            session_id: format!("qq-phone:{identity}"),
            batch_start: 0,
            batch_end: 2,
            messages: vec![
                crate::memory::MemoryMessage {
                    id: format!("{identity}:user"),
                    role: "user".into(),
                    content: user,
                    image_caption: String::new(),
                    do_not_remember: false,
                },
                crate::memory::MemoryMessage {
                    id: format!("{identity}:assistant"),
                    role: "assistant".into(),
                    content: spoken,
                    image_caption: String::new(),
                    do_not_remember: false,
                },
            ],
        },
    )?;
    if result.accepted && !result.duplicate {
        wake_worker();
    }
    Ok(result)
}
async fn complete<C: CallContext>(
    context: &C,
    backend: &mut Socket,
    evidence: (Value, String, String),
) -> Result<(), &'static str> {
    if !context.current() {
        return Err("phone-cancelled");
    }
    // Bridge output completion is not proof the remote person heard it.
    context.remember(evidence.clone());
    send(backend, evidence.0).await
}

#[cfg(test)]
mod transport_tests {
    use super::*;
    use tokio::net::{TcpListener, TcpStream};
    type Peer = WebSocketStream<TcpStream>;
    async fn pair() -> (Socket, Peer) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (client, server) = tokio::join!(
            tokio_tungstenite::connect_async(format!("ws://{address}")),
            async {
                let (stream, _) = listener.accept().await.unwrap();
                tokio_tungstenite::accept_async(stream).await.unwrap()
            }
        );
        (client.unwrap().0, server)
    }
    struct Context {
        current: AtomicBool,
        db: Mutex<rusqlite::Connection>,
        saved: Mutex<Vec<bool>>,
        queries: Mutex<Vec<String>>,
    }
    impl Context {
        fn new() -> Self {
            Self {
                current: AtomicBool::new(true),
                db: Mutex::new(crate::memory::qq_test_connection()),
                saved: Mutex::new(vec![]),
                queries: Mutex::new(vec![]),
            }
        }
    }
    impl CallContext for Context {
        fn current(&self) -> bool {
            self.current.load(Ordering::SeqCst)
        }
        fn connected(&self) {}
        fn recall(&self, query: &str) -> Result<Vec<Value>, &'static str> {
            self.queries.lock().unwrap().push(query.into());
            Ok(vec![
                json!({"kind":"fact","text":"主人喜欢乌龙茶","pinned":true,"uncertain":false}),
            ])
        }
        fn remember(&self, evidence: (Value, String, String)) {
            let cfg = crate::qq::Config {
                nickname: "元宝".into(),
                ..Default::default()
            };
            let r = enqueue_spoken(
                &mut self.db.lock().unwrap(),
                &cfg,
                "test-call",
                &evidence.0,
                evidence.1,
                evidence.2,
                || {},
            )
            .unwrap();
            self.saved.lock().unwrap().push(r.accepted);
        }
    }
    fn chunk() -> Vec<u8> {
        let mut p = b"KXAU\x01\x00\x00\x18".to_vec();
        for n in [7u32, 1, 0, 960] {
            p.extend(n.to_be_bytes());
        }
        p.extend(vec![1; 1920]);
        p
    }
    #[tokio::test]
    async fn real_backend_handshake_offers_streaming_and_preserves_buffered_fallback() {
        for mode in [Some("provider-pcm-v1"), Some("none"), None, Some("unknown")] {
            let (mut client, mut peer) = pair().await;
            let server = tokio::spawn(async move {
                let request: Value =
                    serde_json::from_str(&peer.next().await.unwrap().unwrap().into_text().unwrap())
                        .unwrap();
                let mut session = json!({"type":"session","state":"started","downlinkAudio":"managed-v1","memoryContext":"turn-final-v1"});
                if let Some(mode) = mode {
                    session["ttsStream"] = json!(mode);
                }
                peer.send(Message::Text(session.to_string())).await.unwrap();
                request
            });
            let mut relay = Relay::default();
            let result = start_backend(&mut client, "fixture", "bot", &mut relay).await;
            let request = server.await.unwrap();
            assert_eq!(
                request["ttsStream"],
                json!(["provider-pcm-v1"]),
                "QQ must offer the same provider streaming as local playback"
            );
            assert_eq!(result.is_ok(), mode != Some("unknown"));
            assert_eq!(relay.provider_pcm, mode == Some("provider-pcm-v1"));
        }
    }
    #[tokio::test]
    async fn real_websocket_stream_reaches_qq_before_end_and_memory_waits_for_the_final_played_tail(
    ) {
        let (mut daemon, mut d) = pair().await;
        let (mut backend, mut b) = pair().await;
        let (first_tx, first_rx) = oneshot::channel();
        let (tail_tx, tail_rx) = oneshot::channel();
        let owner = tokio::spawn(async move {
            d.send(Message::Text(
                json!({"type":"call","call":{"id":"call","state":"connected"}}).to_string(),
            ))
            .await
            .unwrap();
            let mut first = Some(first_tx);
            let mut tail = Some(tail_tx);
            let mut count = 0;
            while let Some(Ok(Message::Text(raw))) = d.next().await {
                let frame: Value = serde_json::from_str(&raw).unwrap();
                assert_eq!(frame["op"], "audio.write");
                if let Some(first) = first.take() {
                    first.send(()).unwrap();
                }
                d.send(Message::Text(json!({"type":"playback","receipt":{"callId":"call","id":frame["args"]["playbackId"],"state":"played"}}).to_string())).await.unwrap();
                count += 1;
                if count == 13 {
                    tail.take().unwrap().send(()).unwrap();
                }
            }
            count
        });
        let ai = tokio::spawn(async move {
            let request: Value =
                serde_json::from_str(&b.next().await.unwrap().unwrap().into_text().unwrap())
                    .unwrap();
            assert_eq!(request["ttsStream"], json!(["provider-pcm-v1"]));
            b.send(Message::Text(json!({"type":"session","state":"started","downlinkAudio":"managed-v1","memoryContext":"turn-final-v1","ttsStream":"provider-pcm-v1"}).to_string())).await.unwrap();
            b.send(Message::Text(
                json!({"type":"asr","interim":false,"generation":7,"text":"我喜欢乌龙茶"})
                    .to_string(),
            ))
            .await
            .unwrap();
            b.send(Message::Text(json!({"type":"audio_segment_start","generation":7,"segmentId":1,"streaming":true,"text":"好的，元宝"}).to_string())).await.unwrap();
            for seq in 0..3 {
                b.send(Message::Binary(super::tests::packet(7, 1, seq, 1920)))
                    .await
                    .unwrap();
            }
            // Provider end is deliberately withheld until QQ actually receives
            // early PCM, proving this is incremental through both WS seams.
            tokio::time::timeout(Duration::from_secs(2), first_rx)
                .await
                .unwrap()
                .unwrap();
            b.send(Message::Binary(super::tests::packet(7, 1, 3, 480)))
                .await
                .unwrap();
            b.send(Message::Text(json!({"type":"audio_segment_end","generation":7,"segmentId":1,"status":"completed","samples":6240,"chunks":4}).to_string())).await.unwrap();
            tokio::time::timeout(Duration::from_secs(2), tail_rx)
                .await
                .unwrap()
                .unwrap();
            let receipt: Value =
                serde_json::from_str(&b.next().await.unwrap().unwrap().into_text().unwrap())
                    .unwrap();
            assert_eq!(receipt["type"], "playback_segment");
            assert_eq!(receipt["state"], "completed");
            b.send(Message::Text(
                json!({"type":"session","state":"ended"}).to_string(),
            ))
            .await
            .unwrap();
        });
        let context = Context::new();
        let mut relay = Relay::default();
        relay.call_id = Some("call".into());
        start_backend(&mut backend, "fixture", "bot", &mut relay)
            .await
            .unwrap();
        assert!(relay.provider_pcm);
        let result = tokio::time::timeout(
            Duration::from_secs(3),
            relay_session(
                &context,
                "3407404953",
                "37615985",
                &mut daemon,
                &mut backend,
                &mut relay,
            ),
        )
        .await
        .unwrap();
        assert!(result.is_ok());
        assert_eq!(*context.saved.lock().unwrap(), vec![true]);
        drop(daemon);
        drop(backend);
        assert_eq!(owner.await.unwrap(), 13);
        ai.await.unwrap();
    }
    #[tokio::test]
    async fn real_websockets_transfer_owner_audio_recall_and_commit_only_completed_bridge_playback()
    {
        let (mut daemon, mut d) = pair().await;
        let (mut backend, mut b) = pair().await;
        let owner = tokio::spawn(async move {
            d.send(Message::Text(
                json!({"type":"call","call":{"id":"call","state":"connected"}}).to_string(),
            ))
            .await
            .unwrap();
            d.send(Message::Text(json!({"type":"audio","frame":{"callId":"call","encoding":"pcm_s16le","sampleRate":48000,"channels":1,"sequence":0,"timestamp":0,"data":B64.encode([3,0,6,0,9,0])}}).to_string())).await.unwrap();
            let mut frames = 0;
            while let Some(Ok(Message::Text(raw))) = d.next().await {
                let v: Value = serde_json::from_str(&raw).unwrap();
                assert_eq!(v["op"], "audio.write");
                assert_eq!(v["args"]["frame"]["sampleRate"], 48000);
                assert_eq!(
                    B64.decode(v["args"]["frame"]["data"].as_str().unwrap())
                        .unwrap()
                        .len(),
                    1920
                );
                let receipt =
                    json!({"id":v["args"]["playbackId"],"callId":"call","state":"played"});
                // Nonterminal receipts must not consume the pending playback identity.
                let mut playing = receipt.clone();
                playing["state"] = json!("playing");
                d.send(Message::Text(
                    json!({"type":"playback","receipt":playing}).to_string(),
                ))
                .await
                .unwrap();
                // Exercise both a normal event and an immediate reply-data receipt.
                let ack = if frames == 0 {
                    json!({"type":"playback","receipt":receipt})
                } else {
                    json!({"type":"reply","ok":true,"data":receipt})
                };
                d.send(Message::Text(ack.to_string())).await.unwrap();
                frames += 1;
            }
            assert_eq!(frames, 2);
        });
        let ai = tokio::spawn(async move {
            assert_eq!(
                b.next().await.unwrap().unwrap(),
                Message::Binary(vec![6, 0])
            );
            for v in [
                json!({"type":"asr","interim":false,"generation":7,"text":"我喜欢乌龙茶"}),
                json!({"type":"memory_context_request","generation":7,"reason":"turn"}),
            ] {
                b.send(Message::Text(v.to_string())).await.unwrap();
            }
            let recall: Value =
                serde_json::from_str(&b.next().await.unwrap().unwrap().into_text().unwrap())
                    .unwrap();
            assert_eq!(recall["type"], "memory_context");
            assert_eq!(recall["items"][0]["text"], "主人喜欢乌龙茶");
            b.send(Message::Text(json!({"type":"audio_segment_start","generation":7,"segmentId":1,"samples":960,"text":"好的，元宝"}).to_string())).await.unwrap();
            b.send(Message::Binary(chunk())).await.unwrap();
            b.send(Message::Text(
                json!({"type":"audio_segment_end","generation":7,"segmentId":1}).to_string(),
            ))
            .await
            .unwrap();
            let done: Value =
                serde_json::from_str(&b.next().await.unwrap().unwrap().into_text().unwrap())
                    .unwrap();
            assert_eq!(done["type"], "playback_segment");
            assert_eq!(done["state"], "completed");
            b.send(Message::Text(
                json!({"type":"session","state":"ended"}).to_string(),
            ))
            .await
            .unwrap();
            let _ = b.next().await;
        });
        let context = Context::new();
        let mut relay = Relay::default();
        relay.call_id = Some("call".into());
        let result = tokio::time::timeout(
            Duration::from_secs(3),
            relay_session(
                &context,
                "3407404953",
                "37615985",
                &mut daemon,
                &mut backend,
                &mut relay,
            ),
        )
        .await
        .unwrap();
        assert_eq!(result, Ok(()));
        assert_eq!(*context.saved.lock().unwrap(), vec![true]);
        assert_eq!(*context.queries.lock().unwrap(), vec!["我喜欢乌龙茶"]);
        drop(daemon);
        drop(backend);
        owner.await.unwrap();
        ai.await.unwrap();
    }
    #[tokio::test]
    async fn setting_invalidation_cancels_the_session_without_writing_pending_speech() {
        let (mut daemon, _d) = pair().await;
        let (mut backend, _b) = pair().await;
        let context = Context::new();
        context.current.store(false, Ordering::SeqCst);
        let mut relay = Relay::default();
        relay.call_id = Some("call".into());
        relay
            .backend(&json!({"type":"asr","interim":false,"generation":1,"text":"我喜欢乌龙茶"}))
            .unwrap();
        relay.backend(&json!({"type":"audio_segment_start","generation":1,"segmentId":1,"samples":1,"text":"好的"})).unwrap();
        assert_eq!(
            relay_session(
                &context,
                "3407404953",
                "37615985",
                &mut daemon,
                &mut backend,
                &mut relay
            )
            .await,
            Err("phone-cancelled")
        );
        assert!(context.saved.lock().unwrap().is_empty());
    }
    #[test]
    fn completed_phone_exchange_wakes_idle_consolidation_but_duplicates_and_private_turns_do_not() {
        let mut db = crate::memory::qq_test_connection();
        let cfg = crate::qq::Config {
            nickname: "元宝".into(),
            ..Default::default()
        };
        let receipt = json!({"generation":1,"segmentId":1});
        let (wake, ready) = std::sync::mpsc::channel();
        assert!(
            enqueue_spoken(
                &mut db,
                &cfg,
                "call",
                &receipt,
                "我喜欢乌龙茶".into(),
                "好".into(),
                || wake.send(()).unwrap()
            )
            .unwrap()
            .accepted
        );
        assert!(
            ready.try_recv().is_ok(),
            "a committed real phone turn must wake the idle Memory worker"
        );
        assert!(
            enqueue_spoken(
                &mut db,
                &cfg,
                "call",
                &receipt,
                "我喜欢乌龙茶".into(),
                "好".into(),
                || wake.send(()).unwrap()
            )
            .unwrap()
            .duplicate
        );
        assert!(
            !enqueue_spoken(
                &mut db,
                &cfg,
                "private",
                &receipt,
                "不要保存这轮对话".into(),
                "好".into(),
                || wake.send(()).unwrap()
            )
            .unwrap()
            .accepted
        );
        assert!(
            ready.try_recv().is_err(),
            "duplicates and excluded turns do not schedule work"
        );
        let mut unavailable = rusqlite::Connection::open_in_memory().unwrap();
        assert!(enqueue_spoken(
            &mut unavailable,
            &cfg,
            "failed",
            &receipt,
            "我喜欢乌龙茶".into(),
            "好".into(),
            || wake.send(()).unwrap()
        )
        .is_err());
        assert!(
            ready.try_recv().is_err(),
            "failed writes cannot schedule a nonexistent job"
        );
    }
    #[test]
    fn phone_memory_enqueue_is_idempotent_and_preserves_whole_exchange_privacy() {
        let c = Context::new();
        let cfg = crate::qq::Config {
            nickname: "元宝".into(),
            ..Default::default()
        };
        let mut db = c.db.lock().unwrap();
        let receipt = json!({"generation":1,"segmentId":1});
        assert!(
            enqueue_spoken(
                &mut db,
                &cfg,
                "call",
                &receipt,
                "我喜欢乌龙茶".into(),
                "好的".into(),
                || {}
            )
            .unwrap()
            .accepted
        );
        assert!(
            enqueue_spoken(
                &mut db,
                &cfg,
                "call",
                &receipt,
                "我喜欢乌龙茶".into(),
                "好的".into(),
                || {}
            )
            .unwrap()
            .duplicate
        );
        for private in ["临时口令青柠47", "不要保存这轮对话", "请记住：我喜欢咖啡"]
        {
            assert!(
                !enqueue_spoken(
                    &mut db,
                    &cfg,
                    "private",
                    &receipt,
                    private.into(),
                    "好的".into(),
                    || {}
                )
                .unwrap()
                .accepted
            );
        }
    }
}
