use serde::Serialize;
use std::collections::VecDeque;

const MAX_BUFFERED_FRAMES: usize = 24;
const INITIAL_WINDOW_MS: i64 = 1_000;
const QUIET_WINDOW_MS: i64 = 8_000;
const NORMAL_WINDOW_MS: i64 = 4_000;
const INTENSE_WINDOW_MS: i64 = 2_000;
const SCENE_CUT_DEBOUNCE_MS: i64 = 750;
const QUIET_CHANGE_SCORE: f64 = 0.025;
const NORMAL_CHANGE_SCORE: f64 = 0.04;
const INTENSE_CHANGE_SCORE: f64 = 0.16;
const SCENE_CUT_SCORE: f64 = 0.30;
const MAX_FRAME_DATA_URL_LENGTH: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct VisualFrame {
    pub captured_at_ms: i64,
    pub image_data_url: String,
    pub change_score: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualWindow {
    pub frames: Vec<VisualFramePayload>,
    pub state: &'static str,
    pub reason: &'static str,
    pub sampled_frames: usize,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualFramePayload {
    pub captured_at_ms: i64,
    pub image_data_url: String,
}

pub fn valid_visual_frame_window(frames: &[VisualFramePayload]) -> bool {
    (2..=4).contains(&frames.len())
        && frames.iter().all(|frame| {
            frame.captured_at_ms >= 0
                && frame.image_data_url.len() <= MAX_FRAME_DATA_URL_LENGTH
                && frame.image_data_url.starts_with("data:image/jpeg;base64,")
        })
        && frames
            .windows(2)
            .all(|pair| pair[0].captured_at_ms < pair[1].captured_at_ms)
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VisualSamplerSnapshot {
    pub state: &'static str,
    pub buffered_frames: usize,
    pub sampled_frames: u64,
    pub emitted_windows: u64,
    pub coalesced_frames: u64,
    pub dropped_frames: u64,
    pub latest_change_score_ppm: u32,
    pub next_window_in_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VisualState {
    Quiet,
    Normal,
    Intense,
}

impl VisualState {
    fn label(self) -> &'static str {
        match self {
            Self::Quiet => "quiet",
            Self::Normal => "normal",
            Self::Intense => "intense",
        }
    }

    fn interval_ms(self) -> i64 {
        match self {
            Self::Quiet => QUIET_WINDOW_MS,
            Self::Normal => NORMAL_WINDOW_MS,
            Self::Intense => INTENSE_WINDOW_MS,
        }
    }
}

pub struct AdaptiveVisualSampler {
    frames: VecDeque<VisualFrame>,
    state: VisualState,
    first_frame_at_ms: Option<i64>,
    last_emitted_at_ms: Option<i64>,
    high_streak: u8,
    quiet_streak: u8,
    calm_streak: u8,
    sampled_frames: u64,
    emitted_windows: u64,
    coalesced_frames: u64,
    dropped_frames: u64,
    latest_change_score: f64,
}

impl AdaptiveVisualSampler {
    pub fn new() -> Self {
        Self {
            frames: VecDeque::with_capacity(MAX_BUFFERED_FRAMES),
            state: VisualState::Normal,
            first_frame_at_ms: None,
            last_emitted_at_ms: None,
            high_streak: 0,
            quiet_streak: 0,
            calm_streak: 0,
            sampled_frames: 0,
            emitted_windows: 0,
            coalesced_frames: 0,
            dropped_frames: 0,
            latest_change_score: 0.0,
        }
    }

    pub fn push(&mut self, mut frame: VisualFrame) {
        if frame.captured_at_ms < 0
            || !frame.image_data_url.starts_with("data:image/jpeg;base64,")
            || self
                .frames
                .back()
                .is_some_and(|latest| frame.captured_at_ms <= latest.captured_at_ms)
        {
            self.dropped_frames += 1;
            return;
        }
        frame.change_score = if frame.change_score.is_finite() {
            frame.change_score.clamp(0.0, 1.0)
        } else {
            0.0
        };
        self.first_frame_at_ms.get_or_insert(frame.captured_at_ms);
        self.latest_change_score = frame.change_score;
        self.sampled_frames += 1;
        self.update_state(frame.change_score);
        if self.frames.len() == MAX_BUFFERED_FRAMES {
            self.frames.pop_front();
            self.dropped_frames += 1;
        }
        self.frames.push_back(frame);
    }

    pub fn take_window(&mut self, now_ms: i64) -> Option<VisualWindow> {
        let latest_at_ms = self.frames.back()?.captured_at_ms;
        let candidates = self
            .frames
            .iter()
            .filter(|frame| {
                self.last_emitted_at_ms
                    .is_none_or(|emitted_at_ms| frame.captured_at_ms > emitted_at_ms)
            })
            .cloned()
            .collect::<Vec<_>>();
        if candidates.is_empty() {
            return None;
        }

        let reason = if let Some(last_emitted_at_ms) = self.last_emitted_at_ms {
            let elapsed_ms = latest_at_ms.saturating_sub(last_emitted_at_ms);
            let has_scene_cut = candidates
                .iter()
                .any(|frame| frame.change_score >= SCENE_CUT_SCORE);
            if has_scene_cut && elapsed_ms >= SCENE_CUT_DEBOUNCE_MS {
                "scene-cut"
            } else if elapsed_ms >= self.state.interval_ms() {
                "interval"
            } else {
                return None;
            }
        } else {
            let first_at_ms = self.first_frame_at_ms?;
            if candidates.len() < 2 || latest_at_ms.saturating_sub(first_at_ms) < INITIAL_WINDOW_MS
            {
                return None;
            }
            "initial"
        };

        let sampled_frames = candidates.len();
        let selected = select_representative_frames(&candidates);
        self.coalesced_frames += sampled_frames.saturating_sub(selected.len()) as u64;
        self.emitted_windows += 1;
        self.last_emitted_at_ms = Some(latest_at_ms);
        let latest = self.frames.back().cloned();
        self.frames.clear();
        if let Some(latest) = latest {
            self.frames.push_back(latest);
        }
        let _ = now_ms;
        Some(VisualWindow {
            frames: selected
                .into_iter()
                .map(|frame| VisualFramePayload {
                    captured_at_ms: frame.captured_at_ms,
                    image_data_url: frame.image_data_url,
                })
                .collect(),
            state: self.state.label(),
            reason,
            sampled_frames,
        })
    }

    pub fn snapshot(&self, now_ms: i64) -> VisualSamplerSnapshot {
        let next_window_in_ms = self
            .frames
            .back()
            .map(|latest| {
                let deadline = self
                    .last_emitted_at_ms
                    .map(|at_ms| at_ms.saturating_add(self.state.interval_ms()))
                    .or_else(|| {
                        self.first_frame_at_ms
                            .map(|at_ms| at_ms.saturating_add(INITIAL_WINDOW_MS))
                    })
                    .unwrap_or(latest.captured_at_ms);
                deadline.saturating_sub(now_ms).max(0) as u64
            })
            .unwrap_or(0);
        VisualSamplerSnapshot {
            state: self.state.label(),
            buffered_frames: self.frames.len(),
            sampled_frames: self.sampled_frames,
            emitted_windows: self.emitted_windows,
            coalesced_frames: self.coalesced_frames,
            dropped_frames: self.dropped_frames,
            latest_change_score_ppm: (self.latest_change_score * 1_000_000.0).round() as u32,
            next_window_in_ms,
        }
    }

    pub fn clear(&mut self) {
        *self = Self::new();
    }

    fn update_state(&mut self, change_score: f64) {
        if change_score >= INTENSE_CHANGE_SCORE {
            self.high_streak = self.high_streak.saturating_add(1);
            self.quiet_streak = 0;
            self.calm_streak = 0;
            if self.high_streak >= 2 {
                self.state = VisualState::Intense;
            }
            return;
        }

        self.high_streak = 0;
        if change_score <= QUIET_CHANGE_SCORE {
            self.quiet_streak = self.quiet_streak.saturating_add(1);
        } else {
            self.quiet_streak = 0;
        }
        if change_score < INTENSE_CHANGE_SCORE / 2.0 {
            self.calm_streak = self.calm_streak.saturating_add(1);
        } else {
            self.calm_streak = 0;
        }
        if self.state == VisualState::Intense && self.calm_streak >= 4 {
            self.state = VisualState::Normal;
        }
        if self.quiet_streak >= 12 {
            self.state = VisualState::Quiet;
        } else if self.state == VisualState::Quiet && change_score >= NORMAL_CHANGE_SCORE {
            self.state = VisualState::Normal;
        }
    }
}

fn select_representative_frames(frames: &[VisualFrame]) -> Vec<VisualFrame> {
    if frames.len() <= 4 {
        return frames.to_vec();
    }
    let peak = frames
        .iter()
        .enumerate()
        .max_by(|(_, left), (_, right)| left.change_score.total_cmp(&right.change_score))
        .map(|(index, _)| index)
        .unwrap_or(0);
    let mut indices = vec![0, frames.len() / 2, peak, frames.len() - 1];
    indices.sort_unstable();
    indices.dedup();
    indices
        .into_iter()
        .map(|index| frames[index].clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(at_ms: i64, change_score: f64) -> VisualFrame {
        VisualFrame {
            captured_at_ms: at_ms,
            image_data_url: format!("data:image/jpeg;base64,frame-{at_ms}"),
            change_score,
        }
    }

    #[test]
    fn emits_bounded_chronological_windows_at_an_adaptive_cadence() {
        let mut sampler = AdaptiveVisualSampler::new();
        sampler.push(frame(0, 0.0));
        sampler.push(frame(500, 0.01));
        assert!(sampler.take_window(500).is_none());
        sampler.push(frame(1_000, 0.02));
        let initial = sampler.take_window(1_000).expect("initial visual window");
        assert_eq!(initial.reason, "initial");
        assert_eq!(initial.frames.len(), 3);

        for at_ms in (1_500..=4_500).step_by(500) {
            sampler.push(frame(at_ms, 0.08));
        }
        assert!(sampler.take_window(4_500).is_none());
        sampler.push(frame(5_000, 0.08));
        let normal = sampler.take_window(5_000).expect("normal visual window");
        assert_eq!(normal.state, "normal");
        assert_eq!(normal.reason, "interval");
        assert!(normal.frames.len() <= 4);
        assert!(normal
            .frames
            .windows(2)
            .all(|pair| pair[0].captured_at_ms < pair[1].captured_at_ms));

        for at_ms in [5_500, 6_000, 6_500, 7_000] {
            sampler.push(frame(at_ms, 0.22));
        }
        let intense = sampler.take_window(7_000).expect("intense visual window");
        assert_eq!(intense.state, "intense");
        assert_eq!(intense.reason, "interval");

        sampler.push(frame(7_500, 0.35));
        assert!(sampler.take_window(7_500).is_none());
        sampler.push(frame(8_000, 0.01));
        let cut = sampler.take_window(8_000).expect("scene cut visual window");
        assert_eq!(cut.reason, "scene-cut");

        let snapshot = sampler.snapshot(8_000);
        assert_eq!(snapshot.sampled_frames, 17);
        assert_eq!(snapshot.emitted_windows, 4);
        assert!(snapshot.coalesced_frames > 0);
        assert!(snapshot.latest_change_score_ppm <= 1_000_000);
    }

    #[test]
    fn bounds_the_ephemeral_ring_and_clear_resets_session_state() {
        let mut sampler = AdaptiveVisualSampler::new();
        for index in 0..80 {
            sampler.push(frame(index * 500, 0.01));
        }
        let before = sampler.snapshot(40_000);
        assert!(before.buffered_frames <= 24);
        assert!(before.dropped_frames > 0);

        sampler.clear();
        assert_eq!(
            sampler.snapshot(40_000),
            VisualSamplerSnapshot {
                state: "normal",
                buffered_frames: 0,
                sampled_frames: 0,
                emitted_windows: 0,
                coalesced_frames: 0,
                dropped_frames: 0,
                latest_change_score_ppm: 0,
                next_window_in_ms: 0,
            }
        );
        assert!(sampler.take_window(40_000).is_none());
    }

    #[test]
    fn quiet_content_uses_the_long_heartbeat_and_invalid_frames_fail_closed() {
        let mut sampler = AdaptiveVisualSampler::new();
        for at_ms in (0..=1_000).step_by(500) {
            sampler.push(frame(at_ms, 0.01));
        }
        sampler.take_window(1_000).expect("initial window");
        for at_ms in (1_500..=7_000).step_by(500) {
            sampler.push(frame(at_ms, 0.01));
        }
        assert_eq!(sampler.snapshot(7_000).state, "quiet");
        assert!(sampler.take_window(7_000).is_none());
        for at_ms in (7_500..=9_000).step_by(500) {
            sampler.push(frame(at_ms, 0.01));
        }
        assert_eq!(
            sampler.take_window(9_000).expect("quiet heartbeat").state,
            "quiet"
        );

        sampler.push(frame(8_500, 0.5));
        sampler.push(VisualFrame {
            captured_at_ms: 9_500,
            image_data_url: "data:text/plain;base64,bad".into(),
            change_score: f64::NAN,
        });
        assert_eq!(sampler.snapshot(9_500).dropped_frames, 2);
    }

    #[test]
    fn ipc_frame_windows_require_bounded_ordered_jpegs() {
        let frames = vec![
            VisualFramePayload {
                captured_at_ms: 1_000,
                image_data_url: "data:image/jpeg;base64,one".into(),
            },
            VisualFramePayload {
                captured_at_ms: 1_500,
                image_data_url: "data:image/jpeg;base64,two".into(),
            },
        ];
        assert!(valid_visual_frame_window(&frames));
        assert!(!valid_visual_frame_window(&[
            VisualFramePayload {
                captured_at_ms: -1,
                image_data_url: "data:image/jpeg;base64,one".into()
            },
            frames[1].clone(),
        ]));
        assert!(!valid_visual_frame_window(&frames[..1]));
        assert!(!valid_visual_frame_window(&[
            frames[1].clone(),
            frames[0].clone()
        ]));
        assert!(!valid_visual_frame_window(&[
            frames[0].clone(),
            VisualFramePayload {
                captured_at_ms: 1_500,
                image_data_url: "data:image/png;base64,two".into()
            },
        ]));
    }
}
