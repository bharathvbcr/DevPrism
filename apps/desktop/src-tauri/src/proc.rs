//! Bounded child-process execution.
//!
//! `std::process::Command::output()` waits forever. That is not safe for the
//! tools this app shells out to:
//!
//! - TeX can genuinely loop forever (`\def\x{\x}\x`, a runaway `\loop`, a
//!   pathological package). `-interaction=nonstopmode` prevents *interactive*
//!   hangs but not macro-expansion hangs.
//! - A hung compile holds a `MAX_CONCURRENT` semaphore permit, the per-project
//!   lock, and a blocking-pool thread. Three of them and the app can no longer
//!   compile anything until it is restarted, with the spinner stuck on.
//!
//! So every child process gets a deadline and is killed when it passes.

use std::io::Read;
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

/// How often to check whether the child has exited. Small enough that a fast
/// command is not noticeably delayed, large enough not to spin a core.
const POLL_INTERVAL: Duration = Duration::from_millis(20);

/// Upper bound on stdout/stderr bytes *retained* per stream.
///
/// Every consumer of `run_with_timeout` treats output as text (compiler
/// diagnostics, tool versions, log tails); none of it legitimately approaches
/// this bound. Without a cap, a document that spews diagnostics until its
/// deadline allocates gigabytes across concurrent compiles and can OOM the
/// app. The pipe is still drained past the cap — stopping reads would block
/// the child on a full pipe and reintroduce the deadlock this module exists
/// to prevent.
const MAX_CAPTURED_OUTPUT: usize = 64 * 1024 * 1024;

/// Read `pipe` to EOF, retaining at most `cap` bytes and discarding the rest.
fn drain_capped(pipe: &mut impl Read, cap: usize) -> Vec<u8> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 16 * 1024];
    loop {
        match pipe.read(&mut chunk) {
            Ok(0) => return buf,
            Ok(n) => {
                let room = cap.saturating_sub(buf.len());
                if room > 0 {
                    let take = n.min(room);
                    buf.extend_from_slice(&chunk[..take]);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return buf,
        }
    }
}

#[derive(Debug)]
pub enum ProcError {
    /// The process could not be started at all.
    Spawn(String),
    /// The process outlived its deadline and was killed.
    TimedOut { after: Duration, killed: bool },
    /// The caller asked for the process to be cancelled (e.g. a newer compile
    /// superseded this one) and it was killed.
    Cancelled,
    /// An I/O error while waiting or reading output.
    Io(String),
}

impl ProcError {
    pub fn to_message(&self, what: &str) -> String {
        match self {
            ProcError::Spawn(e) => format!("Failed to run {what}: {e}"),
            ProcError::TimedOut { after, killed } => format!(
                "{what} did not finish within {}s and was {}. \
                 This usually means the document contains a loop that never \
                 terminates (for example a macro that expands to itself).",
                after.as_secs(),
                if *killed { "stopped" } else { "abandoned" }
            ),
            ProcError::Cancelled => format!("{what} was cancelled"),
            ProcError::Io(e) => format!("Error while running {what}: {e}"),
        }
    }
}

/// Drain a child's stdout and stderr on separate threads.
///
/// Reading must happen concurrently with waiting: a child that fills the OS
/// pipe buffer blocks on write, and if we were only polling `try_wait` it would
/// never exit — a deadlock that looks exactly like the hang we are preventing.
fn spawn_readers(child: &mut Child) -> (
    Option<std::thread::JoinHandle<Vec<u8>>>,
    Option<std::thread::JoinHandle<Vec<u8>>>,
) {
    let out = child.stdout.take().map(|mut pipe| {
        std::thread::spawn(move || drain_capped(&mut pipe, MAX_CAPTURED_OUTPUT))
    });
    let err = child.stderr.take().map(|mut pipe| {
        std::thread::spawn(move || drain_capped(&mut pipe, MAX_CAPTURED_OUTPUT))
    });
    (out, err)
}

/// Run `cmd` to completion, kill it once `timeout` elapses, or kill it as soon
/// as `cancelled()` returns true — whichever comes first.
///
/// Captures stdout/stderr like `Command::output()`. `stdin` is set to null, so
/// a tool that tries to prompt sees EOF instead of blocking.
pub fn run_with_timeout_and_cancel(
    mut cmd: Command,
    timeout: Duration,
    cancelled: impl Fn() -> bool,
) -> Result<Output, ProcError> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| ProcError::Spawn(e.to_string()))?;
    let (out_reader, err_reader) = spawn_readers(&mut child);

    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout = out_reader.and_then(|h| h.join().ok()).unwrap_or_default();
                let stderr = err_reader.and_then(|h| h.join().ok()).unwrap_or_default();
                return Ok(Output { status, stdout, stderr });
            }
            Ok(None) => {}
            Err(e) => return Err(ProcError::Io(e.to_string())),
        }

        if cancelled() || started.elapsed() >= timeout {
            let was_cancelled = cancelled();
            let killed = child.kill().is_ok();
            // Reap so the child does not linger as a zombie.
            let _ = child.wait();

            // Deliberately do NOT join the readers here.
            //
            // Killing the child does not kill *its* children, and a wrapper
            // (a shell script, `latexmk` spawning an engine) leaves a
            // grandchild holding the write end of the pipe. `read_to_end`
            // would then block until that grandchild exits — reintroducing
            // exactly the hang this function exists to prevent. We do not need
            // the output on the timeout path, so the threads are detached and
            // retire on their own when the pipe finally closes.
            drop(out_reader);
            drop(err_reader);

            if was_cancelled {
                return Err(ProcError::Cancelled);
            }
            return Err(ProcError::TimedOut {
                after: started.elapsed(),
                killed,
            });
        }

        std::thread::sleep(POLL_INTERVAL);
    }
}

/// Run `cmd` to completion or kill it once `timeout` elapses.
pub fn run_with_timeout(cmd: Command, timeout: Duration) -> Result<Output, ProcError> {
    run_with_timeout_and_cancel(cmd, timeout, || false)
}

/// Whether `cmd` exits successfully within `timeout`. Used for availability
/// probes (`--version`), where any failure means "not usable".
pub fn succeeds_within(cmd: Command, timeout: Duration) -> bool {
    matches!(run_with_timeout(cmd, timeout), Ok(out) if out.status.success())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sh(script: &str) -> Command {
        let mut c = Command::new("sh");
        c.arg("-c").arg(script);
        c
    }

    #[cfg(unix)]
    #[test]
    fn returns_output_for_a_fast_command() {
        let out = run_with_timeout(sh("printf hello"), Duration::from_secs(10))
            .expect("should complete");
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout), "hello");
    }

    #[cfg(unix)]
    #[test]
    fn captures_stderr_and_exit_code() {
        let out = run_with_timeout(sh("printf oops >&2; exit 3"), Duration::from_secs(10))
            .expect("should complete");
        assert_eq!(out.status.code(), Some(3));
        assert_eq!(String::from_utf8_lossy(&out.stderr), "oops");
    }

    #[cfg(unix)]
    #[test]
    fn kills_a_process_that_outlives_its_deadline() {
        let started = Instant::now();
        let err = run_with_timeout(sh("sleep 30"), Duration::from_millis(300))
            .expect_err("must time out");
        match err {
            ProcError::TimedOut { killed, .. } => assert!(killed, "child was not killed"),
            other => panic!("expected TimedOut, got {other:?}"),
        }
        // Must return promptly rather than waiting out the sleep.
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "took {:?}",
            started.elapsed()
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_chatty_child_does_not_deadlock_the_pipe() {
        // Far more than a pipe buffer (64 KiB on Linux, 8-64 KiB on macOS).
        let out = run_with_timeout(
            sh("i=0; while [ $i -lt 4000 ]; do printf 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\\n'; i=$((i+1)); done"),
            Duration::from_secs(30),
        )
        .expect("should complete");
        assert!(out.status.success());
        assert!(out.stdout.len() > 100_000, "got {} bytes", out.stdout.len());
    }

    #[cfg(unix)]
    #[test]
    fn a_flooding_child_cannot_exhaust_memory_via_unbounded_capture() {
        // 70 MiB in one blast — more than the capture cap. The reader must
        // keep draining the pipe (or the child deadlocks on a full buffer)
        // while the captured buffer stays bounded. A pathological document
        // that spews diagnostics until its deadline must not take the app
        // down with it.
        let out = run_with_timeout(sh("head -c 73400320 /dev/zero"), Duration::from_secs(60))
            .expect("should complete");
        assert!(out.status.success());
        assert_eq!(
            out.stdout.len(),
            64 * 1024 * 1024,
            "capture should be capped at 64 MiB, got {} bytes",
            out.stdout.len()
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_hanging_grandchild_does_not_block_the_timeout() {
        // `sh -c "...; sleep 30"` leaves `sleep` holding the stdout pipe after
        // the shell is killed. If the timeout path joined the reader threads it
        // would wait out the full 30s — the original bug this test caught.
        let started = Instant::now();
        let err = run_with_timeout(
            sh("i=0; while [ $i -lt 2000 ]; do printf 'yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy\\n'; i=$((i+1)); done; sleep 30"),
            Duration::from_millis(500),
        )
        .expect_err("must time out");
        assert!(matches!(err, ProcError::TimedOut { .. }));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[cfg(unix)]
    #[test]
    fn stdin_is_null_so_a_prompting_child_does_not_block() {
        // `read` gets EOF immediately instead of waiting for a terminal.
        let started = Instant::now();
        let out = run_with_timeout(sh("read line; echo done"), Duration::from_secs(5))
            .expect("should complete");
        assert!(String::from_utf8_lossy(&out.stdout).contains("done"));
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn spawn_failure_is_reported_not_panicked() {
        let err = run_with_timeout(
            Command::new("definitely-not-a-real-binary-xyz"),
            Duration::from_secs(5),
        )
        .expect_err("must fail to spawn");
        assert!(matches!(err, ProcError::Spawn(_)));
        assert!(err.to_message("thing").contains("Failed to run thing"));
    }

    #[cfg(unix)]
    #[test]
    fn succeeds_within_reports_exit_status() {
        assert!(succeeds_within(sh("true"), Duration::from_secs(5)));
        assert!(!succeeds_within(sh("false"), Duration::from_secs(5)));
        assert!(!succeeds_within(sh("sleep 30"), Duration::from_millis(200)));
    }

    #[cfg(unix)]
    #[test]
    fn many_concurrent_runs_all_settle() {
        // The app compiles up to MAX_CONCURRENT documents at once and probes
        // several tools at startup. Mixed fast/slow/hanging children must all
        // resolve promptly and independently — no shared state, no wedging.
        let started = Instant::now();
        let handles: Vec<_> = (0..24)
            .map(|i| {
                std::thread::spawn(move || match i % 4 {
                    0 => run_with_timeout(sh("printf ok"), Duration::from_secs(10)).is_ok(),
                    1 => run_with_timeout(sh("exit 1"), Duration::from_secs(10)).is_ok(),
                    2 => matches!(
                        run_with_timeout(sh("sleep 30"), Duration::from_millis(200)),
                        Err(ProcError::TimedOut { .. })
                    ),
                    _ => matches!(
                        run_with_timeout(
                            sh("i=0; while [ $i -lt 500 ]; do echo spam; i=$((i+1)); done; sleep 30"),
                            Duration::from_millis(300),
                        ),
                        Err(ProcError::TimedOut { .. })
                    ),
                })
            })
            .collect();

        let results: Vec<bool> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert!(results.iter().all(|ok| *ok), "some runs misbehaved: {results:?}");
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "concurrent runs took {:?} — something serialized or wedged",
            started.elapsed()
        );
    }

    #[cfg(unix)]
    #[test]
    fn repeated_timeouts_do_not_degrade() {
        // Three hangs used to exhaust MAX_CONCURRENT permanently. Killing must
        // stay cheap and repeatable so capacity always comes back.
        for round in 0..8 {
            let started = Instant::now();
            let err = run_with_timeout(sh("sleep 30"), Duration::from_millis(150))
                .expect_err("must time out");
            assert!(matches!(err, ProcError::TimedOut { .. }), "round {round}");
            assert!(
                started.elapsed() < Duration::from_secs(3),
                "round {round} took {:?}",
                started.elapsed()
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_child_killed_by_a_signal_is_reported_not_hung() {
        let out = run_with_timeout(sh("kill -9 $$"), Duration::from_secs(10))
            .expect("should return");
        assert!(!out.status.success());
    }

    #[cfg(unix)]
    #[test]
    fn zero_timeout_kills_immediately_without_panicking() {
        let err = run_with_timeout(sh("sleep 10"), Duration::from_millis(0))
            .expect_err("must time out");
        assert!(matches!(err, ProcError::TimedOut { .. }));
    }

    #[cfg(unix)]
    #[test]
    fn cancel_flag_kills_a_running_child_promptly() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        let cancelled = Arc::new(AtomicBool::new(false));
        let c = cancelled.clone();
        // Cancel shortly after the child starts, from another thread.
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            c.store(true, Ordering::Relaxed);
        });

        let started = Instant::now();
        let err = run_with_timeout_and_cancel(
            sh("sleep 30"),
            Duration::from_secs(60),
            || cancelled.load(Ordering::Relaxed),
        )
        .expect_err("must be cancelled");
        assert!(matches!(err, ProcError::Cancelled));
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "cancel took {:?}",
            started.elapsed()
        );
    }

    #[cfg(unix)]
    #[test]
    fn pre_cancelled_flag_does_not_even_start_the_run_longer_than_a_poll() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let cancelled = AtomicBool::new(true);
        let started = Instant::now();
        let err = run_with_timeout_and_cancel(
            sh("sleep 30"),
            Duration::from_secs(60),
            || cancelled.load(Ordering::Relaxed),
        )
        .expect_err("must be cancelled");
        assert!(matches!(err, ProcError::Cancelled));
        assert!(started.elapsed() < Duration::from_secs(2));

        let msg = err.to_message("Compilation");
        assert!(msg.contains("cancelled"));
    }

    #[cfg(unix)]
    #[test]
    fn cancel_flag_flipping_storm_never_hangs_or_double_kills() {
        // Multiple threads flip the flag rapidly while a child runs. The
        // poll loop must observe *a* consistent outcome — completion or a
        // single Cancelled — and never wedge or panic.
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        for round in 0..8 {
            let cancelled = Arc::new(AtomicBool::new(false));
            let flippers: Vec<_> = (0..4)
                .map(|_| {
                    let c = cancelled.clone();
                    std::thread::spawn(move || {
                        let mut value = false;
                        for _ in 0..50 {
                            value = !value;
                            c.store(value, Ordering::Relaxed);
                            std::thread::sleep(Duration::from_millis(2));
                        }
                        // Leave it set so the run terminates deterministically.
                        c.store(true, Ordering::Relaxed);
                    })
                })
                .collect();

            let result = run_with_timeout_and_cancel(
                sh("sleep 5"),
                Duration::from_secs(30),
                || cancelled.load(Ordering::Relaxed),
            );

            match result {
                Ok(_) => {}
                Err(ProcError::Cancelled) => {}
                Err(other) => panic!("round {round}: unexpected error {other:?}"),
            }
            for h in flippers {
                h.join().expect("flipper thread panicked");
            }
        }
    }

    #[test]
    fn timeout_message_explains_the_likely_cause() {
        let msg = ProcError::TimedOut {
            after: Duration::from_secs(120),
            killed: true,
        }
        .to_message("Compilation");
        assert!(msg.contains("120s"));
        assert!(msg.contains("loop that never"));
    }
}
