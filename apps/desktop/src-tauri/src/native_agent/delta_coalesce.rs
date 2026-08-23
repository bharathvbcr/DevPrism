//! Coalescing for streaming deltas before they cross IPC.
//!
//! The chat callback used to emit one `streaming_delta` Tauri event per model
//! fragment; local models can emit hundreds of tiny fragments per second, and
//! each event costs a full store commit plus re-render in the webview. This
//! coalescer merges adjacent same-kind fragments and returns flush decisions
//! on size, latency, or kind boundaries — the assembled message is
//! byte-identical, delivered in fewer, larger events.
//!
//! The coalescer is a pure decision machine: it never touches Tauri. `push`
//! and `finish` return the block to emit (if any); the call site owns the
//! window emission. That keeps every decision unit-testable without a runtime.

use super::ollama::StreamDeltaKind;
use serde_json::json;
use std::time::{Duration, Instant};

/// Flush once this much text is buffered (checked *before* absorbing a new
/// fragment, so a block stays below `FLUSH_BYTES + one fragment`).
const FLUSH_BYTES: usize = 1024;

/// Flush when the oldest buffered fragment is this old — bounds UI latency
/// for slow, steady streams instead of letting text sit invisible.
pub(crate) const FLUSH_INTERVAL: Duration = Duration::from_millis(40);

/// A coalesced delta ready for IPC.
pub type DeltaBlock = (StreamDeltaKind, String);

#[derive(Default)]
pub struct DeltaCoalescer {
    kind: Option<StreamDeltaKind>,
    parts: Vec<String>,
    bytes: usize,
    opened_at: Option<Instant>,
}

impl DeltaCoalescer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed one fragment. Returns a buffered block to emit first when the new
    /// fragment cannot join it (kind switch, size cap reached, or the buffer
    /// has been open longer than [`FLUSH_INTERVAL`]).
    pub fn push(
        &mut self,
        kind: StreamDeltaKind,
        frag: &str,
        now: Instant,
    ) -> Option<DeltaBlock> {
        if frag.is_empty() {
            return None;
        }

        let flushed = match self.kind {
            None => None,
            Some(buffered_kind) => {
                let boundary_reached = buffered_kind != kind
                    || self.bytes >= FLUSH_BYTES
                    || self
                        .opened_at
                        .is_some_and(|t| now.duration_since(t) >= FLUSH_INTERVAL);
                if boundary_reached {
                    Some((buffered_kind, self.take()))
                } else {
                    None
                }
            }
        };

        if self.kind.is_none() {
            // Fresh buffer (first fragment ever, or just flushed).
            self.opened_at = Some(now);
        }
        self.kind = Some(kind);
        self.parts.push(frag.to_string());
        self.bytes += frag.len();
        flushed
    }

    /// Drain whatever remains at end of stream. Call exactly once on success,
    /// error, and stop paths so no tail text is lost.
    pub fn finish(&mut self) -> Option<DeltaBlock> {
        let kind = self.kind?;
        Some((kind, self.take()))
    }

    fn take(&mut self) -> String {
        let mut parts = std::mem::take(&mut self.parts);
        let joined = parts.join("");
        parts.clear(); // release capacity
        self.kind = None;
        self.bytes = 0;
        self.opened_at = None;
        joined
    }
}

/// Shape a coalesced block into the `streaming_delta` event the webview
/// already understands.
pub fn streaming_delta_event(kind: StreamDeltaKind, text: &str) -> serde_json::Value {
    let block = match kind {
        StreamDeltaKind::Thinking => json!({ "type": "thinking", "thinking": text }),
        StreamDeltaKind::Text => json!({ "type": "text", "text": text }),
    };
    json!({
        "type": "assistant",
        "subtype": "streaming_delta",
        "message": { "content": [block] },
    })
}

/// Bundles the coalescer with its emission sink so the chat loop stays two
/// calls (`push` / `finish`) and every decision — buffering, boundaries,
/// tail flushing — is exercisable in tests through a capturing sink.
///
/// The production constructor wires the real IPC emit; tests inject a
/// recording closure. Nothing else differs between the two.
pub struct DeltaForwarder<S>
where
    S: FnMut(StreamDeltaKind, &str),
{
    coalescer: DeltaCoalescer,
    emit: S,
}

impl<S: FnMut(StreamDeltaKind, &str)> DeltaForwarder<S> {
    pub fn new(emit: S) -> Self {
        Self {
            coalescer: DeltaCoalescer::new(),
            emit,
        }
    }

    /// Feed one fragment; emits a coalesced block when a boundary fires.
    pub fn push(&mut self, kind: StreamDeltaKind, frag: &str) {
        if let Some((k, text)) = self.coalescer.push(kind, frag, Instant::now()) {
            (self.emit)(k, &text);
        }
    }

    /// Drain the tail. Returns true when something was emitted. Safe to call
    /// on every exit path; extra calls are no-ops.
    pub fn finish(&mut self) -> bool {
        match self.coalescer.finish() {
            Some((k, text)) => {
                (self.emit)(k, &text);
                true
            }
            None => false,
        }
    }
}

#[cfg(test)]
mod forwarder_tests {
    use super::*;

    type Recording = Vec<(StreamDeltaKind, String)>;

    fn recorder() -> (
        DeltaForwarder<impl FnMut(StreamDeltaKind, &str)>,
        std::rc::Rc<std::cell::RefCell<Recording>>,
    ) {
        let captured: std::rc::Rc<std::cell::RefCell<Recording>> =
            std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
        let sink_handle = captured.clone();
        let forwarder =
            DeltaForwarder::new(move |kind, text| {
                sink_handle.borrow_mut().push((kind, text.to_string()));
            });
        (forwarder, captured)
    }

    /// The exact protocol the native-agent chat loop must implement:
    /// fragments stream through push(); finish() runs on the error path AND
    /// once more after the loop for stop/normal exits. No text may ever be
    /// lost or duplicated across any of those combinations.
    #[test]
    fn exit_path_matrix_never_loses_or_duplicates_text() {
        for stop_after_pushes in 0..6 {
            // Normal completion: pushes → finish once.
            {
                let (mut f, out) = recorder();
                for i in 0..stop_after_pushes {
                    f.push(StreamDeltaKind::Text, &format!("t{i}"));
                }
                assert!(f.finish() || stop_after_pushes == 0);
                assert!(!f.finish(), "second finish must be a no-op");
                let text: String = out
                    .borrow()
                    .iter()
                    .map(|(_, t)| t.as_str())
                    .collect();
                assert_eq!(text, (0..stop_after_pushes).map(|i| format!("t{i}")).collect::<String>());
            }
            // Error path: finish before "emit_result", then the convergent
            // post-loop finish — combined output still complete, exactly once.
            {
                let (mut f, out) = recorder();
                for i in 0..stop_after_pushes {
                    f.push(StreamDeltaKind::Text, &format!("t{i}"));
                }
                let _ = f.finish();
                let _ = f.finish();
                let text: String = out
                    .borrow()
                    .iter()
                    .map(|(_, t)| t.as_str())
                    .collect();
                assert_eq!(text, (0..stop_after_pushes).map(|i| format!("t{i}")).collect::<String>());
                assert_eq!(out.borrow().len() <= 1, true);
            }
        }
    }

    #[test]
    fn rapid_burst_emits_bounded_number_of_events_and_preserves_bytes() {
        let (mut f, out) = recorder();
        let frag = "x".repeat(64);
        let count = 200;
        for _ in 0..count {
            f.push(StreamDeltaKind::Text, &frag);
        }
        f.finish();

        let events = out.borrow().len();
        // 200×64B = 12.8KB ⇒ at most ⌈12800/1024⌉ + 1 boundary events + tail.
        assert!(
            events <= 16,
            "burst of {count} fragments produced {events} events — coalescing broken"
        );
        let total: usize = out.borrow().iter().map(|(_, t)| t.len()).sum();
        assert_eq!(total, count * 64, "bytes must be preserved exactly");
        assert!(out
            .borrow()
            .iter()
            .all(|(k, _)| *k == StreamDeltaKind::Text));
    }

    #[test]
    fn kind_switches_are_never_merged_across_boundary() {
        let (mut f, out) = recorder();
        f.push(StreamDeltaKind::Thinking, "thought");
        f.push(StreamDeltaKind::Text, "answer");
        f.finish();

        let blocks = out.borrow();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].0, StreamDeltaKind::Thinking);
        assert_eq!(blocks[0].1, "thought");
        assert_eq!(blocks[1].0, StreamDeltaKind::Text);
        assert_eq!(blocks[1].1, "answer");
    }

    /// Real-clock latency window: a slow steady stream must not hold text
    /// longer than FLUSH_INTERVAL (+ scheduling slack).
    #[test]
    fn slow_stream_flushes_within_latency_window() {
        let (mut f, out) = recorder();
        f.push(StreamDeltaKind::Text, "first");
        assert!(out.borrow().is_empty());
        std::thread::sleep(super::FLUSH_INTERVAL + Duration::from_millis(15));
        f.push(StreamDeltaKind::Text, "second");
        assert_eq!(out.borrow().len(), 1);
        assert_eq!(out.borrow()[0].1, "first");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(ms: u64) -> Instant {
        Instant::now() + Duration::from_millis(ms)
    }

    #[test]
    fn adjacent_same_kind_fragments_buffer_until_boundary() {
        let mut c = DeltaCoalescer::new();
        assert_eq!(c.push(StreamDeltaKind::Text, "Hello", t(0)), None);
        assert_eq!(c.push(StreamDeltaKind::Text, ", ", t(1)), None);
        assert_eq!(c.push(StreamDeltaKind::Text, "world", t(2)), None);

        // Kind switch forces a flush of everything before it.
        assert_eq!(
            c.push(StreamDeltaKind::Thinking, "hmm", t(3)),
            Some((StreamDeltaKind::Text, "Hello, world".to_string()))
        );
        // The thinking fragment itself is buffered, not emitted yet.
        assert_eq!(
            c.finish(),
            Some((StreamDeltaKind::Thinking, "hmm".to_string()))
        );
        assert_eq!(c.finish(), None);
    }

    #[test]
    fn latency_window_flushes_slow_steady_streams() {
        let mut c = DeltaCoalescer::new();
        assert_eq!(c.push(StreamDeltaKind::Text, "a", t(0)), None);

        // 39ms later: still inside the window → buffered.
        assert_eq!(c.push(StreamDeltaKind::Text, "b", t(39)), None);

        // At 40ms: the window elapses; existing buffer flushes and the new
        // fragment opens the next one.
        assert_eq!(
            c.push(StreamDeltaKind::Text, "c", t(40)),
            Some((StreamDeltaKind::Text, "ab".to_string()))
        );
        assert_eq!(c.finish(), Some((StreamDeltaKind::Text, "c".to_string())));
    }

    #[test]
    fn empty_fragments_never_disturb_the_buffer() {
        let mut c = DeltaCoalescer::new();
        assert_eq!(c.push(StreamDeltaKind::Text, "x", t(0)), None);
        // Empty fragment must not reset opened_at (else latency flushing
        // could be starved indefinitely by a chatty-but-empty source).
        assert_eq!(c.push(StreamDeltaKind::Text, "", t(39)), None);
        // At t(40) the window from the ORIGINAL open (t(0)) elapses — proof
        // the empty push did not refresh the clock.
        assert_eq!(
            c.push(StreamDeltaKind::Text, "y", t(40)),
            Some((StreamDeltaKind::Text, "x".to_string()))
        );
        assert_eq!(c.finish(), Some((StreamDeltaKind::Text, "y".to_string())));
    }

    #[test]
    fn size_cap_flushes_before_absorbing_large_fragments() {
        let mut c = DeltaCoalescer::new();
        let big = "x".repeat(FLUSH_BYTES);
        assert_eq!(c.push(StreamDeltaKind::Text, &big, t(0)), None);
        // Buffer is at the cap: next push flushes first.
        assert_eq!(
            c.push(StreamDeltaKind::Text, "tail", t(1)),
            Some((StreamDeltaKind::Text, big.clone()))
        );
        assert_eq!(c.finish(), Some((StreamDeltaKind::Text, "tail".into())));
    }

    #[test]
    fn finish_drains_and_is_idempotent_afterwards() {
        let mut c = DeltaCoalescer::new();
        assert_eq!(c.finish(), None);
        assert_eq!(c.push(StreamDeltaKind::Thinking, "thought", t(0)), None);
        assert_eq!(
            c.finish(),
            Some((StreamDeltaKind::Thinking, "thought".into()))
        );
        assert_eq!(c.finish(), None);
        // Reusable after finish.
        assert_eq!(c.push(StreamDeltaKind::Text, "more", t(1)), None);
        assert_eq!(c.finish(), Some((StreamDeltaKind::Text, "more".into())));
    }

    /// Property-style check across a deterministic pseudo-random stream:
    /// concatenating all emitted blocks plus nothing else must equal the
    /// concatenated input, with no cross-kind merging.
    #[test]
    fn roundtrip_preserves_order_and_content_across_kinds() {
        let mut lcg: u32 = 0xC0FFEE;
        let mut rand = move || {
            lcg = lcg.wrapping_mul(1664525).wrapping_add(1013904223);
            lcg >> 16
        };

        // Build a deterministic mixed stream of Thinking/Text fragments.
        let mut input: Vec<(StreamDeltaKind, String)> = Vec::new();
        for i in 0..400 {
            let kind = if rand() % 2 == 0 {
                StreamDeltaKind::Text
            } else {
                StreamDeltaKind::Thinking
            };
            let len = 1 + (rand() % 24) as usize;
            input.push((kind, format!("{}{:03}", if i % 7 == 0 { "\n" } else { "" }, i).repeat(len / 4 + 1)));
        }

        let mut c = DeltaCoalescer::new();
        let mut out_text = Vec::<String>::new();
        let mut out_kinds = Vec::<StreamDeltaKind>::new();
        for (i, (kind, frag)) in input.iter().enumerate() {
            if let Some((k, text)) = c.push(*kind, frag, t(i as u64)) {
                out_kinds.push(k);
                out_text.push(text);
            }
        }
        if let Some((k, text)) = c.finish() {
            out_kinds.push(k);
            out_text.push(text);
        }

        // Content preserved exactly.
        let expected: String = input.iter().map(|(_, f)| f.as_str()).collect();
        let actual: String = out_text.concat();
        assert_eq!(actual, expected);

        // No two adjacent emitted blocks share a kind (kind switches always
        // force a boundary), except where identical kinds were separated by a
        // size/time flush — those are legal too, so only assert ordering by
        // replaying kinds against input transitions.
        let mut input_iter = input.iter().peekable();
        for k in &out_kinds {
            while let Some((ik, _)) = input_iter.peek() {
                if *ik == *k {
                    break;
                }
                input_iter.next();
            }
            assert_eq!(
                input_iter.peek().map(|(ik, _)| *ik),
                Some(*k),
                "emitted kind {k:?} must match the next pending input kind"
            );
        }
    }
}
