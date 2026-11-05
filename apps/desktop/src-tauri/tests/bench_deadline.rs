//! Harness-side deadline. This is not the in-engine Typst deadline.
//!
//! A worker that does not return is an error. It must not be reported as a
//! duration. The calling process exits on that error; this function itself
//! only stops waiting.

use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::Duration;

#[derive(Debug, PartialEq, Eq)]
pub enum DeadlineError {
    Exceeded { deadline_ms: u128 },
    /// The worker ended without sending a value (it panicked, or dropped the
    /// sender). That is not a successful measurement either.
    WorkerStopped,
}

pub fn run_with_deadline<T: Send + 'static>(
    deadline: Duration,
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, DeadlineError> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let value = work();
        let _ = tx.send(value);
    });
    match rx.recv_timeout(deadline) {
        Ok(value) => Ok(value),
        Err(RecvTimeoutError::Timeout) => Err(DeadlineError::Exceeded {
            deadline_ms: deadline.as_millis(),
        }),
        Err(RecvTimeoutError::Disconnected) => Err(DeadlineError::WorkerStopped),
    }
}

/// A worker that sleeps past the deadline must come back as `Exceeded`, and
/// the wait must end before the worker does. Returns false if it does not.
pub fn hang_is_not_a_value() -> bool {
    let started = std::time::Instant::now();
    let result = run_with_deadline(Duration::from_millis(40), || {
        thread::sleep(Duration::from_secs(2));
        1
    });
    result == Err(DeadlineError::Exceeded { deadline_ms: 40 })
        && started.elapsed() < Duration::from_millis(1000)
}

pub fn finished_work_is_a_value() -> bool {
    matches!(
        run_with_deadline(Duration::from_secs(2), || 7),
        Ok(7)
    )
}
