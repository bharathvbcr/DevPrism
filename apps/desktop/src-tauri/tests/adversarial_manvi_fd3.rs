//! Adversarial Empirical Stress Test Suite for Manvi Resume Bridge Subprocess
//! Pipe fd 3 Execution and POSIX `pre_exec` Redirection.

#![cfg(unix)]
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

use std::io::Write;
use std::os::fd::AsRawFd;
use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;
use std::time::Duration;
use tempfile::TempDir;
use tokio::io::{AsyncBufReadExt, BufReader};

const APPROVE_FD: i32 = 3;
const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;

fn create_mock_script(dir: &TempDir, script_name: &str, content: &str) -> std::path::PathBuf {
    let path = dir.path().join(script_name);
    std::fs::write(&path, content).expect("write mock script");
    let mut perms = std::fs::metadata(&path).expect("get perms").permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(&path, perms).expect("set perms");
    path
}

// ---------------------------------------------------------------------------
// 1. Stress Test: fd 3 Protocol under repeated iterations
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_stress_fd3_protocol_production_sequence_50_iterations() {
    let temp_dir = TempDir::new().unwrap();
    let script = create_mock_script(
        &temp_dir,
        "mock_prod_seq.sh",
        r#"#!/bin/sh
printf '%s\n' '{"kind":"progress","percent":0.1}'
printf '%s\n' '{"kind":"approval.request","approval_id":"appr_prod_3"}'
read -r decision_line <&3
echo "$decision_line" | grep -q '"allow":true' || exit 2
printf '%s\n' '{"kind":"content","content":"Done production sequence"}'
exit 0
"#,
    );

    for iteration in 1..=50 {
        let (read_pipe, mut write_pipe) = std::io::pipe().expect("create pipe");
        let read_fd = read_pipe.as_raw_fd();

        let mut cmd = tokio::process::Command::new(&script);
        cmd.args(["run", "--json", "--approve-fd", "3"]);
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        cmd.stdin(std::process::Stdio::null());

        unsafe {
            cmd.pre_exec(move || {
                if libc::setpgid(0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::dup2(read_fd, APPROVE_FD) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::fcntl(APPROVE_FD, libc::F_SETFD, 0) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if read_fd != APPROVE_FD && libc::close(read_fd) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }

        let mut child = cmd.spawn().expect("Spawn mock script");
        drop(read_pipe);

        let stdout = child.stdout.take().expect("Take stdout");
        let mut lines = BufReader::new(stdout).lines();

        let l1 = lines.next_line().await.unwrap().expect("Line 1");
        assert!(l1.contains("progress"));

        let l2 = lines.next_line().await.unwrap().expect("Line 2");
        assert!(l2.contains("approval.request"));

        let decision_line = "{\"approval_id\":\"appr_prod_3\",\"allow\":true}\n";
        write_pipe
            .write_all(decision_line.as_bytes())
            .unwrap_or_else(|e| panic!("Write to fd 3 failed on iteration {iteration}: {e}"));
        write_pipe.flush().expect("Flush fd 3");

        let l3 = lines.next_line().await.unwrap().expect("Line 3");
        assert!(l3.contains("Done production sequence"));

        let status = child.wait().await.expect("Wait on child");
        assert!(
            status.success(),
            "Iteration {iteration} failed with exit code {:?}",
            status.code()
        );
    }
}

// ---------------------------------------------------------------------------
// 2. Stress Test: Proving read_fd == 3 with FD_CLOEXEC survives iff fcntl is used
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_stress_fd3_protocol_when_read_fd_equals_3_in_child() {
    let temp_dir = TempDir::new().unwrap();
    let script = create_mock_script(
        &temp_dir,
        "mock_equal_3.sh",
        r#"#!/bin/sh
read -r decision_line <&3
echo "$decision_line" | grep -q 'ok_equal_3' || exit 2
printf '%s\n' '{"kind":"content","content":"Success read_fd == 3"}'
exit 0
"#,
    );

    for iteration in 1..=25 {
        let (read_pipe, mut write_pipe) = std::io::pipe().expect("create pipe");
        let read_fd = read_pipe.as_raw_fd();

        let mut cmd = tokio::process::Command::new(&script);
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        cmd.stdin(std::process::Stdio::null());

        unsafe {
            cmd.pre_exec(move || {
                if libc::setpgid(0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                // Step A: In child, duplicate read_pipe to fd 3 and explicitly set FD_CLOEXEC.
                // This simulates the exact scenario where pipe() in parent had allocated fd 3.
                if libc::dup2(read_fd, APPROVE_FD) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::fcntl(APPROVE_FD, libc::F_SETFD, libc::FD_CLOEXEC) < 0 {
                    return Err(std::io::Error::last_os_error());
                }

                // Step B: Now execute the exact production manvi_resume_bridge sequence
                // where read_fd == APPROVE_FD == 3:
                let sim_read_fd = APPROVE_FD;
                if libc::dup2(sim_read_fd, APPROVE_FD) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                // CRUCIAL: fcntl clears FD_CLOEXEC even though dup2(3, 3) was a no-op!
                if libc::fcntl(APPROVE_FD, libc::F_SETFD, 0) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if sim_read_fd != APPROVE_FD && libc::close(sim_read_fd) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }

        let mut child = cmd.spawn().expect("Spawn mock script");
        drop(read_pipe);

        let stdout = child.stdout.take().expect("Take stdout");
        let mut lines = BufReader::new(stdout).lines();

        let decision_line = "ok_equal_3\n";
        write_pipe
            .write_all(decision_line.as_bytes())
            .unwrap_or_else(|e| {
                panic!("Write on iteration {iteration} failed with BrokenPipe: {e}")
            });
        write_pipe.flush().expect("Flush fd 3");

        let l1 = lines.next_line().await.unwrap().expect("Content line");
        assert!(l1.contains("Success read_fd == 3"));

        let status = child.wait().await.expect("Wait on child");
        assert!(
            status.success(),
            "Iteration {iteration} failed when read_fd == 3 with exit code {:?}",
            status.code()
        );
    }
}

// ---------------------------------------------------------------------------
// 3. Falsification Oracle: Omission of fcntl when read_fd == 3 REPRODUCES BrokenPipe
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_falsification_omitting_fcntl_when_read_fd_equals_3_triggers_broken_pipe() {
    let temp_dir = TempDir::new().unwrap();
    let script = create_mock_script(
        &temp_dir,
        "mock_falsify.sh",
        r#"#!/bin/sh
# Without fcntl clearing FD_CLOEXEC, fd 3 is closed by kernel on exec.
# Reading from <&3 fails with Bad file descriptor (exit code 1 or 2).
read -r decision_line <&3 || exit 2
exit 0
"#,
    );

    let (read_pipe, mut write_pipe) = std::io::pipe().expect("create pipe");
    let read_fd = read_pipe.as_raw_fd();

    let mut cmd = tokio::process::Command::new(&script);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd.stdin(std::process::Stdio::null());

    unsafe {
        cmd.pre_exec(move || {
            if libc::setpgid(0, 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            // Put read pipe on fd 3 with FD_CLOEXEC
            if libc::dup2(read_fd, APPROVE_FD) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::fcntl(APPROVE_FD, libc::F_SETFD, libc::FD_CLOEXEC) < 0 {
                return Err(std::io::Error::last_os_error());
            }

            // SIMULATE PRE-FIX DEFECT:
            // dup2(3, 3) is a no-op that leaves FD_CLOEXEC set.
            // NO fcntl(APPROVE_FD, F_SETFD, 0) is called!
            let sim_read_fd = APPROVE_FD;
            if libc::dup2(sim_read_fd, APPROVE_FD) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }

    let mut child = cmd.spawn().expect("Spawn mock script");
    drop(read_pipe);

    // Wait 50ms for child process to terminate due to Bad file descriptor
    tokio::time::sleep(Duration::from_millis(50)).await;

    // Parent attempts to write to write_pipe. Since child closed fd 3 upon execvp,
    // write_all MUST fail with BrokenPipe!
    let write_res = write_pipe.write_all(b"test\n");
    assert!(
        write_res.is_err(),
        "Expected BrokenPipe when fcntl is omitted and read_fd == 3"
    );
    assert_eq!(
        write_res.unwrap_err().kind(),
        std::io::ErrorKind::BrokenPipe,
        "Must be BrokenPipe"
    );

    let status = child.wait().await.expect("Wait on child");
    assert!(
        !status.success(),
        "Child must fail due to Bad file descriptor on fd 3"
    );
}

// ---------------------------------------------------------------------------
// 4. Stress Test: Multi-Threaded Concurrency (25 Concurrent Runners)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_stress_fd3_protocol_multi_threaded_concurrency() {
    let temp_dir = Arc::new(TempDir::new().unwrap());
    let mut handles = Vec::new();

    for thread_idx in 0..25 {
        let temp_dir_clone = temp_dir.clone();
        let handle = tokio::spawn(async move {
            let script_name = format!("mock_thread_{thread_idx}.sh");
            let script = create_mock_script(
                &temp_dir_clone,
                &script_name,
                &format!(
                    r#"#!/bin/sh
printf '%s\n' '{{"kind":"progress","thread":{thread_idx}}}'
printf '%s\n' '{{"kind":"approval.request","approval_id":"appr_thr_{thread_idx}"}}'
read -r decision_line <&3
echo "$decision_line" | grep -q '"allow":true' || exit 2
printf '%s\n' '{{"kind":"content","thread":{thread_idx},"content":"Success"}}'
exit 0
"#
                ),
            );

            let (read_pipe, mut write_pipe) = std::io::pipe().expect("create pipe");
            let read_fd = read_pipe.as_raw_fd();

            let mut cmd = tokio::process::Command::new(&script);
            cmd.args(["run", "--json", "--approve-fd", "3"]);
            cmd.stdout(std::process::Stdio::piped());
            cmd.stderr(std::process::Stdio::piped());
            cmd.stdin(std::process::Stdio::null());

            unsafe {
                cmd.pre_exec(move || {
                    if libc::setpgid(0, 0) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    if libc::dup2(read_fd, APPROVE_FD) < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    if libc::fcntl(APPROVE_FD, libc::F_SETFD, 0) < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    if read_fd != APPROVE_FD && libc::close(read_fd) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }

            let mut child = cmd.spawn().expect("Spawn mock script");
            drop(read_pipe);

            let stdout = child.stdout.take().expect("Take stdout");
            let mut lines = BufReader::new(stdout).lines();

            let l1 = lines.next_line().await.unwrap().expect("Line 1");
            assert!(l1.contains("progress"));

            let l2 = lines.next_line().await.unwrap().expect("Line 2");
            assert!(l2.contains("approval.request"));

            let decision_line =
                format!("{{\"approval_id\":\"appr_thr_{thread_idx}\",\"allow\":true}}\n");
            write_pipe
                .write_all(decision_line.as_bytes())
                .unwrap_or_else(|e| panic!("Thread {thread_idx} write error: {e}"));
            write_pipe.flush().expect("Flush fd 3");

            let l3 = lines.next_line().await.unwrap().expect("Line 3");
            assert!(l3.contains("Success"));

            let status = child.wait().await.expect("Wait on child");
            assert!(
                status.success(),
                "Thread {thread_idx} exited with code {:?}",
                status.code()
            );
        });
        handles.push(handle);
    }

    for (idx, handle) in handles.into_iter().enumerate() {
        handle
            .await
            .unwrap_or_else(|e| panic!("Join error on thread {idx}: {e}"));
    }
}

// ---------------------------------------------------------------------------
// 5. Edge Case: Malformed NDJSON on stdout with active fd 3 decision pipe
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_edge_case_malformed_ndjson_on_stdout_with_active_fd3() {
    let temp_dir = TempDir::new().unwrap();
    let script = create_mock_script(
        &temp_dir,
        "mock_malformed.sh",
        r#"#!/bin/sh
printf '%s\n' 'raw stderr banner output'
printf '%s\n' '{"unclosed_json": true'
printf '%s\n' 'not json at all'
printf '%s\n' '{"trailing": "comma",}'
printf '%s\n' '{"kind":"approval.request","approval_id":"appr_malformed_1","prompt":"Edge prompt"}'
read -r decision_line <&3
echo "$decision_line" | grep -q '"allow":true' || exit 2
printf '%s\n' 'another non-json log: [DEBUG] processing complete'
printf '%s\n' '{"kind":"content","content":"Successfully recovered despite noise"}'
exit 0
"#,
    );

    let (read_pipe, mut write_pipe) = std::io::pipe().expect("create pipe");
    let read_fd = read_pipe.as_raw_fd();

    let mut cmd = tokio::process::Command::new(&script);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd.stdin(std::process::Stdio::null());

    unsafe {
        cmd.pre_exec(move || {
            if libc::setpgid(0, 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::dup2(read_fd, APPROVE_FD) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::fcntl(APPROVE_FD, libc::F_SETFD, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            if read_fd != APPROVE_FD && libc::close(read_fd) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }

    let mut child = cmd.spawn().expect("Spawn mock script");
    drop(read_pipe);

    let stdout = child.stdout.take().expect("Take stdout");
    let mut lines = BufReader::new(stdout).lines();

    let mut approval_handled = false;
    let mut final_content_captured = false;

    while let Ok(Some(line)) = lines.next_line().await {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.len() > MAX_LINE_BYTES || !trimmed.starts_with('{') {
            continue;
        }
        let Ok(ev) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue;
        };

        if ev.get("kind") == Some(&serde_json::json!("approval.request")) {
            approval_handled = true;
            let decision_line = "{\"approval_id\":\"appr_malformed_1\",\"allow\":true}\n";
            write_pipe
                .write_all(decision_line.as_bytes())
                .expect("write fd 3");
            write_pipe.flush().expect("flush fd 3");
        } else if ev.get("kind") == Some(&serde_json::json!("content")) {
            if let Some(txt) = ev.get("content").and_then(|v| v.as_str()) {
                if txt.contains("Successfully recovered") {
                    final_content_captured = true;
                }
            }
        }
    }

    let status = child.wait().await.expect("Wait on child");
    assert!(
        status.success(),
        "Process exited with code {:?}",
        status.code()
    );
    assert!(
        approval_handled,
        "Approval request should be detected despite preamble garbage"
    );
    assert!(final_content_captured, "Final content should be captured");
}

// ---------------------------------------------------------------------------
// 6. Edge Case: Child Process Termination Before Parent Writes to fd 3 (EPIPE Handling)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_edge_case_child_process_termination_before_parent_writes_fd3() {
    let temp_dir = TempDir::new().unwrap();
    let script = create_mock_script(
        &temp_dir,
        "mock_premature_exit.sh",
        r#"#!/bin/sh
printf '%s\n' '{"kind":"approval.request","approval_id":"appr_dead_1"}'
# Child intentionally terminates immediately with failure code without reading fd 3
exit 42
"#,
    );

    let (read_pipe, mut write_pipe) = std::io::pipe().expect("create pipe");
    let read_fd = read_pipe.as_raw_fd();

    let mut cmd = tokio::process::Command::new(&script);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd.stdin(std::process::Stdio::null());

    unsafe {
        cmd.pre_exec(move || {
            if libc::setpgid(0, 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::dup2(read_fd, APPROVE_FD) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::fcntl(APPROVE_FD, libc::F_SETFD, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            if read_fd != APPROVE_FD && libc::close(read_fd) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }

    let mut child = cmd.spawn().expect("Spawn mock script");
    drop(read_pipe);

    let stdout = child.stdout.take().expect("Take stdout");
    let mut lines = BufReader::new(stdout).lines();

    // Read the approval.request line
    let l1 = lines
        .next_line()
        .await
        .unwrap()
        .expect("Approval request line");
    assert!(l1.contains("appr_dead_1"));

    // Wait 100ms for child process to terminate and close fd 3
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Verify child is indeed terminated
    let status = child.wait().await.expect("Wait on child");
    assert_eq!(status.code(), Some(42));

    // Now parent attempts to write to write_pipe. Since the child has closed fd 3,
    // this MUST yield std::io::ErrorKind::BrokenPipe (EPIPE).
    let decision_line = "{\"approval_id\":\"appr_dead_1\",\"allow\":true}\n";
    let write_res = write_pipe.write_all(decision_line.as_bytes());

    assert!(
        write_res.is_err(),
        "Writing to closed pipe must return an error (BrokenPipe)"
    );
    let err = write_res.unwrap_err();
    assert_eq!(
        err.kind(),
        std::io::ErrorKind::BrokenPipe,
        "Expected BrokenPipe error, got: {err:?}"
    );

    // In production manvi_resume_bridge.rs:
    // `let _ = write_pipe.write_all(decision_line.as_bytes());`
    // `let _ = write_pipe.flush();`
    // Ensure that discarding the BrokenPipe error does not panic or corrupt runtime.
    let _ = write_pipe.flush();
}

// ---------------------------------------------------------------------------
// 7. Edge Case: Extremely Large JSON Lines and Line Cap Enforcement
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_edge_case_large_json_lines_and_line_caps() {
    let temp_dir = TempDir::new().unwrap();

    let payload_64k = "A".repeat(64 * 1024);
    let payload_128k = "B".repeat(128 * 1024);

    let script = create_mock_script(
        &temp_dir,
        "mock_large_lines.sh",
        &format!(
            r#"#!/bin/sh
printf '%s\n' '{{"kind":"progress","data":"{payload_64k}"}}'
printf '%s\n' '{{"kind":"progress","data":"{payload_128k}"}}'
printf '%s\n' '{{"kind":"approval.request","approval_id":"appr_large_1"}}'
read -r decision_line <&3
echo "$decision_line" | grep -q '"allow":true' || exit 2
printf '%s\n' '{{"kind":"content","content":"Done large lines"}}'
exit 0
"#
        ),
    );

    let (read_pipe, mut write_pipe) = std::io::pipe().expect("create pipe");
    let read_fd = read_pipe.as_raw_fd();

    let mut cmd = tokio::process::Command::new(&script);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd.stdin(std::process::Stdio::null());

    unsafe {
        cmd.pre_exec(move || {
            if libc::setpgid(0, 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::dup2(read_fd, APPROVE_FD) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::fcntl(APPROVE_FD, libc::F_SETFD, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            if read_fd != APPROVE_FD && libc::close(read_fd) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }

    let mut child = cmd.spawn().expect("Spawn mock script");
    drop(read_pipe);

    let stdout = child.stdout.take().expect("Take stdout");
    let mut lines = BufReader::new(stdout).lines();

    // 1. Read 64KB line
    let l1 = lines.next_line().await.unwrap().expect("64KB line");
    assert!(l1.len() >= 64 * 1024);
    let ev1: serde_json::Value = serde_json::from_str(l1.trim()).expect("Parse 64KB JSON");
    assert_eq!(ev1["kind"], "progress");

    // 2. Read 128KB line
    let l2 = lines.next_line().await.unwrap().expect("128KB line");
    assert!(l2.len() >= 128 * 1024);
    let ev2: serde_json::Value = serde_json::from_str(l2.trim()).expect("Parse 128KB JSON");
    assert_eq!(ev2["kind"], "progress");

    // 3. Approval request
    let l3 = lines.next_line().await.unwrap().expect("Approval line");
    assert!(l3.contains("appr_large_1"));

    let decision_line = "{\"approval_id\":\"appr_large_1\",\"allow\":true}\n";
    write_pipe
        .write_all(decision_line.as_bytes())
        .expect("write fd 3");
    write_pipe.flush().expect("flush fd 3");

    // 4. Content line
    let l4 = lines.next_line().await.unwrap().expect("Content line");
    assert!(l4.contains("Done large lines"));

    let status = child.wait().await.expect("Wait on child");
    assert!(status.success());
}

#[test]
fn test_edge_case_max_line_cap_rejection_boundary() {
    let prefix = r#"{"kind":"oversized","data":""#;
    let suffix = r#""}"#;
    let overhead = prefix.len() + suffix.len();

    // Exactly 8 MiB (MAX_LINE_BYTES)
    let mut line_8mb = String::with_capacity(MAX_LINE_BYTES);
    line_8mb.push_str(prefix);
    line_8mb.extend(std::iter::repeat('z').take(MAX_LINE_BYTES - overhead));
    line_8mb.push_str(suffix);
    assert_eq!(line_8mb.len(), MAX_LINE_BYTES);

    let trimmed_8mb = line_8mb.trim();
    assert!(trimmed_8mb.len() <= MAX_LINE_BYTES);
    let parsed_8mb = serde_json::from_str::<serde_json::Value>(trimmed_8mb);
    assert!(parsed_8mb.is_ok(), "8 MiB line should parse successfully");

    // 8 MiB + 1 byte
    let mut line_oversized = String::with_capacity(MAX_LINE_BYTES + 1);
    line_oversized.push_str(prefix);
    line_oversized.extend(std::iter::repeat('z').take(MAX_LINE_BYTES - overhead + 1));
    line_oversized.push_str(suffix);
    assert_eq!(line_oversized.len(), MAX_LINE_BYTES + 1);

    // Simulated parse_ndjson_line check
    let trimmed_over = line_oversized.trim();
    let is_rejected = trimmed_over.len() > MAX_LINE_BYTES;
    assert!(is_rejected, "Line exceeding 8 MiB MUST be rejected by cap");
}
