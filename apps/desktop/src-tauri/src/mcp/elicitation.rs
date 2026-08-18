//! Server-bound, single-use elicitation tokens for MRTR (SEP-2322).
//!
//! # Why this exists
//!
//! SEP-2322 describes `requestState` as "self-contained": the server hands the
//! client an opaque blob and the client hands it back on the second round trip.
//! Taken literally that makes the *presence* of a blob the only thing standing
//! between a caller and whatever the elicitation was gating. For a confirmation
//! on a destructive tool that is not a gate at all — the caller simply attaches
//! any blob and skips the prompt.
//!
//! `career_delete_block` gates permanent deletion of an experience block and all
//! of its embeddings behind exactly such a confirmation, so the token has to be
//! unforgeable. Two ways to get there:
//!
//! 1. **Sign it.** Keeps the token literally self-contained, but a signed token
//!    is valid until it expires, so it is replayable: one confirmed delete
//!    yields a token that authorises that same delete again.
//! 2. **Issue a random nonce and remember it.** Not self-contained across
//!    processes, but single-use, so replay is impossible.
//!
//! This module implements (2). The wire format is unchanged — the nonce travels
//! inside the same base64 `requestState` envelope, so clients need no changes —
//! and the process-local table is bounded and self-reaping. The server already
//! keeps process-local state for the Tasks extension (`tasks.rs`), so this
//! introduces no new class of state.
//!
//! A token is accepted only if it is known, unexpired, and was issued **for this
//! tool and this subject**. That last binding is what stops a token issued to
//! confirm deleting block A from authorising the deletion of block B.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

/// How long a pending confirmation stays valid. Long enough for a human to read
/// a prompt and answer, short enough that an abandoned token does not linger.
const ELICITATION_TTL_MS: i64 = 5 * 60 * 1000;

/// Hard cap on outstanding confirmations. Reached only by a caller that opens
/// elicitations and never answers them, which is exactly the case that must not
/// be allowed to grow without bound.
const MAX_PENDING_ELICITATIONS: usize = 256;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Why a `requestState` was refused. Reported to the caller as-is: a caller that
/// legitimately raced the TTL deserves to know it expired rather than being told
/// its token was bogus.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ElicitationRejection {
    /// Never issued by this server, already used, or evicted.
    Unknown,
    /// Issued, but the TTL has passed.
    Expired,
    /// Issued for a different tool.
    ToolMismatch,
    /// Issued for a different subject (e.g. a different block id).
    SubjectMismatch,
}

impl ElicitationRejection {
    pub fn detail(self) -> &'static str {
        match self {
            Self::Unknown => {
                "requestState was not issued by this server, or has already been used"
            }
            Self::Expired => "requestState has expired; re-request confirmation",
            Self::ToolMismatch => "requestState was issued for a different tool",
            Self::SubjectMismatch => "requestState was issued for a different subject",
        }
    }
}

#[derive(Debug, Clone)]
struct PendingElicitation {
    tool: String,
    subject: String,
    issued_at: i64,
    expires_at: i64,
}

/// Bounded table of outstanding elicitations, keyed by an unguessable nonce.
#[derive(Default)]
pub struct ElicitationStore {
    pending: Mutex<HashMap<String, PendingElicitation>>,
}

impl ElicitationStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Recover the map even if a previous holder panicked.
    ///
    /// Poisoning must not silently disable the gate: a store that answers "no
    /// such token" because a lock is poisoned would fail *closed* here (good),
    /// but `issue` would fail *open* by handing out a nonce it never recorded,
    /// which then never validates. Recovering keeps both halves consistent.
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, PendingElicitation>> {
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Issue a single-use nonce bound to `tool` and `subject`.
    pub fn issue(&self, tool: &str, subject: &str) -> String {
        let nonce = Uuid::new_v4().to_string();
        let now = now_ms();
        let mut pending = self.lock();

        pending.retain(|_, p| p.expires_at > now);

        // Still full after reaping: drop the oldest to make room. Evicting the
        // oldest (rather than refusing to issue) keeps a caller that abandons
        // confirmations from locking out a caller that answers them.
        while pending.len() >= MAX_PENDING_ELICITATIONS {
            let oldest = pending
                .iter()
                .min_by_key(|(_, p)| p.issued_at)
                .map(|(k, _)| k.clone());
            let Some(oldest) = oldest else { break };
            pending.remove(&oldest);
        }

        pending.insert(
            nonce.clone(),
            PendingElicitation {
                tool: tool.to_string(),
                subject: subject.to_string(),
                issued_at: now,
                expires_at: now + ELICITATION_TTL_MS,
            },
        );
        nonce
    }

    /// Consume a nonce. Succeeds at most once per issued nonce.
    ///
    /// The entry is removed on *every* recognised nonce, including expired and
    /// mismatched ones, so a wrong guess cannot be retried against a still-live
    /// token.
    pub fn consume(
        &self,
        nonce: &str,
        tool: &str,
        subject: &str,
    ) -> Result<(), ElicitationRejection> {
        let now = now_ms();
        let mut pending = self.lock();

        let Some(entry) = pending.remove(nonce) else {
            return Err(ElicitationRejection::Unknown);
        };
        if entry.expires_at <= now {
            return Err(ElicitationRejection::Expired);
        }
        if entry.tool != tool {
            return Err(ElicitationRejection::ToolMismatch);
        }
        if entry.subject != subject {
            return Err(ElicitationRejection::SubjectMismatch);
        }
        Ok(())
    }

    /// Outstanding (unexpired) elicitations. Test/introspection helper.
    pub fn pending_count(&self) -> usize {
        let now = now_ms();
        self.lock().values().filter(|p| p.expires_at > now).count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_freshly_issued_token_is_accepted_once() {
        let store = ElicitationStore::new();
        let nonce = store.issue("career_delete_block", "block-1");
        assert_eq!(store.consume(&nonce, "career_delete_block", "block-1"), Ok(()));
    }

    #[test]
    fn a_token_cannot_be_replayed() {
        let store = ElicitationStore::new();
        let nonce = store.issue("career_delete_block", "block-1");
        assert_eq!(store.consume(&nonce, "career_delete_block", "block-1"), Ok(()));
        assert_eq!(
            store.consume(&nonce, "career_delete_block", "block-1"),
            Err(ElicitationRejection::Unknown),
            "a confirmed deletion must not authorise a second one"
        );
    }

    #[test]
    fn a_forged_token_is_rejected() {
        let store = ElicitationStore::new();
        // The pre-fix bypass: any value at all was accepted.
        for forged in ["", "e30=", "not-base64", &Uuid::new_v4().to_string()] {
            assert_eq!(
                store.consume(forged, "career_delete_block", "block-1"),
                Err(ElicitationRejection::Unknown)
            );
        }
    }

    #[test]
    fn a_token_for_one_block_cannot_delete_another() {
        let store = ElicitationStore::new();
        let nonce = store.issue("career_delete_block", "block-safe");
        assert_eq!(
            store.consume(&nonce, "career_delete_block", "block-victim"),
            Err(ElicitationRejection::SubjectMismatch)
        );
    }

    #[test]
    fn a_token_for_one_tool_cannot_be_used_on_another() {
        let store = ElicitationStore::new();
        let nonce = store.issue("career_export_space", "block-1");
        assert_eq!(
            store.consume(&nonce, "career_delete_block", "block-1"),
            Err(ElicitationRejection::ToolMismatch)
        );
    }

    #[test]
    fn a_rejected_token_is_burned_rather_than_left_live() {
        let store = ElicitationStore::new();
        let nonce = store.issue("career_delete_block", "block-safe");
        assert_eq!(
            store.consume(&nonce, "career_delete_block", "block-victim"),
            Err(ElicitationRejection::SubjectMismatch)
        );
        // Guessing the subject on a second try must not work.
        assert_eq!(
            store.consume(&nonce, "career_delete_block", "block-safe"),
            Err(ElicitationRejection::Unknown)
        );
    }

    #[test]
    fn the_pending_table_stays_bounded_under_abandoned_elicitations() {
        let store = ElicitationStore::new();
        for i in 0..(MAX_PENDING_ELICITATIONS * 4) {
            store.issue("career_delete_block", &format!("block-{i}"));
        }
        assert!(
            store.pending_count() <= MAX_PENDING_ELICITATIONS,
            "abandoned confirmations must not grow without bound, got {}",
            store.pending_count()
        );
    }

    #[test]
    fn the_newest_token_survives_eviction_pressure() {
        let store = ElicitationStore::new();
        for i in 0..(MAX_PENDING_ELICITATIONS * 2) {
            store.issue("career_delete_block", &format!("filler-{i}"));
        }
        let nonce = store.issue("career_delete_block", "block-1");
        assert_eq!(store.consume(&nonce, "career_delete_block", "block-1"), Ok(()));
    }
}
