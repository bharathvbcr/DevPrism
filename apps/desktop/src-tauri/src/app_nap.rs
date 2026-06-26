//! macOS App Nap suppression.
//!
//! `backgroundThrottling: "disabled"` (tauri.conf.json) only stops WebKit timers
//! *inside* the webview. It does NOT stop macOS App Nap from throttling the Rust
//! host and its child processes (the Claude CLI, Tectonic) when the window is
//! backgrounded or fully occluded. Long Claude streams and LaTeX compiles can
//! stall while the user is in another app.
//!
//! `NSProcessInfo -beginActivityWithOptions:reason:` (macOS 10.9+, public API)
//! registers an activity that suppresses App Nap until the matching activity is
//! ended. We ref-count begin/end so overlapping streams and compiles keep a
//! single live activity, ended only when the last holder is dropped.
//!
//! The activity token is documented as safe to begin/end from any thread.
//! objc2 conservatively marks `Retained<ProtocolObject<dyn NSObjectProtocol>>`
//! as `!Send + !Sync`, so we wrap it and assert thread-safety to allow storing
//! it in a global behind a `Mutex`.

use std::sync::Mutex;

use objc2::rc::Retained;
use objc2::runtime::{NSObjectProtocol, ProtocolObject};
use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};

/// `-beginActivityWithOptions:reason:` returns `id<NSObject>`, mapped by objc2 to
/// `Retained<ProtocolObject<dyn NSObjectProtocol>>`.
struct Token(Retained<ProtocolObject<dyn NSObjectProtocol>>);

// Safe to create/retain/end from any thread (per Apple docs); see module note.
unsafe impl Send for Token {}
unsafe impl Sync for Token {}

struct NapState {
    depth: usize,
    token: Option<Token>,
}

static STATE: Mutex<NapState> = Mutex::new(NapState {
    depth: 0,
    token: None,
});

fn acquire(reason: &str) {
    let Ok(mut s) = STATE.lock() else { return };
    s.depth += 1;
    if s.token.is_none() {
        // UserInitiated keeps CPU/timers alive while unfocused; LatencyCritical
        // additionally resists App Nap's aggressive throttling.
        let opts = NSActivityOptions::UserInitiated | NSActivityOptions::LatencyCritical;
        let pi = NSProcessInfo::processInfo();
        let token = unsafe { pi.beginActivityWithOptions_reason(opts, &NSString::from_str(reason)) };
        s.token = Some(Token(token));
    }
}

fn release() {
    let Ok(mut s) = STATE.lock() else { return };
    if s.depth == 0 {
        return;
    }
    s.depth -= 1;
    if s.depth == 0 {
        if let Some(tok) = s.token.take() {
            let pi = NSProcessInfo::processInfo();
            unsafe { pi.endActivity(&tok.0) };
        }
    }
}

/// RAII guard: suppresses App Nap while alive, restores it on drop.
///
/// Hold one for the lifetime of a long-running task (a Claude stream, a LaTeX
/// compile). Dropping it on any exit path — success, error, or kill — releases
/// the activity, so there is no path that leaks a permanently-awake process.
#[must_use = "dropping the guard immediately re-enables App Nap"]
pub struct NapActivity;

impl NapActivity {
    pub fn begin(reason: &str) -> Self {
        acquire(reason);
        NapActivity
    }
}

impl Drop for NapActivity {
    fn drop(&mut self) {
        release();
    }
}
