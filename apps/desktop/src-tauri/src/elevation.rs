//! One AppleScript elevation path for directory repair.
//!
//! `uv` and the skills installer both used to embed a shell script in
//! `do shell script "…"`. POSIX `'\''` quoting injects a raw `"` into that
//! AppleScript string, and an unchecked username was interpolated into the
//! root script. This module owns the quoting, the username check, and the
//! deadline. It does not change installer download commands.

use std::path::Path;
use std::process::Output;
use std::time::Duration;

/// How long to wait on the macOS administrator prompt. Matches the previous
/// skills-installer bound so a dismissed dialog fails on its own.
pub const ELEVATION_TIMEOUT_SECS: u64 = 120;
pub const ELEVATION_TIMEOUT: Duration = Duration::from_secs(ELEVATION_TIMEOUT_SECS);

/// POSIX account names we will place, unquoted, after `chown -R`.
/// First character: ASCII letter or `_`. Then ASCII alphanumeric, `_`, or `-`.
pub fn is_valid_username(user: &str) -> bool {
    let mut chars = user.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Quote `text` as one POSIX single-quoted word (`'\''` for an embedded `'`).
pub fn shell_single_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

/// Escape `\` and `"` and wrap `text` as an AppleScript double-quoted literal.
///
/// The shell script is placed inside this literal. Escaping both characters
/// means a `"` introduced by `'\''` cannot terminate the AppleScript string,
/// and a backslash cannot eat the following character.
pub fn apple_script_quoted(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len() + 2);
    escaped.push('"');
    for ch in text.chars() {
        if ch == '\\' || ch == '"' {
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    escaped.push('"');
    escaped
}

/// `osascript -e` source that runs `shell_script` as administrator.
pub fn osascript_admin_source(shell_script: &str) -> String {
    format!(
        "do shell script {} with administrator privileges",
        apple_script_quoted(shell_script)
    )
}

/// `mkdir -p <mkdir_path> && chown -R <user> <chown_path>`.
///
/// An invalid username is refused and is not interpolated into the script.
pub fn build_mkdir_chown_script(
    mkdir_path: &Path,
    user: &str,
    chown_path: &Path,
) -> Result<String, String> {
    if !is_valid_username(user) {
        return Err(
            "Refusing elevated directory repair: username is not a safe POSIX account name."
                .to_string(),
        );
    }
    Ok(format!(
        "mkdir -p {} && chown -R {} {}",
        shell_single_quote(&mkdir_path.to_string_lossy()),
        user,
        shell_single_quote(&chown_path.to_string_lossy())
    ))
}

fn timeout_message(timeout: Duration) -> String {
    if timeout.as_secs() >= 1 {
        format!(
            "Administrator prompt was cancelled or timed out after {}s; directory permissions were not changed.",
            timeout.as_secs()
        )
    } else {
        format!("Command timed out after {}ms", timeout.as_millis())
    }
}

/// Run `cmd` with `kill_on_drop` and a hard deadline.
///
/// Tests inject a stand-in command. Production passes `osascript` built by
/// [`osascript_admin_source`]. Dropping the timed-out child kills it; this
/// does not open an administrator dialog unless `cmd` is that `osascript`.
pub async fn run_command_bounded(
    mut cmd: tokio::process::Command,
    timeout: Duration,
) -> Result<Output, String> {
    cmd.kill_on_drop(true);
    cmd.stdin(std::process::Stdio::null());
    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn elevated command: {e}"))?;
    match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(e)) => Err(format!("Failed to run elevated command: {e}")),
        Err(_) => Err(timeout_message(timeout)),
    }
}

/// Prompt for administrator rights and run `shell_script`. Bounded by
/// [`ELEVATION_TIMEOUT`]. Does not wait forever.
pub async fn run_administrator_shell(shell_script: &str) -> Result<(), String> {
    let source = osascript_admin_source(shell_script);
    let mut cmd = tokio::process::Command::new("osascript");
    cmd.arg("-e");
    cmd.arg(source);
    let output = run_command_bounded(cmd, ELEVATION_TIMEOUT).await?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Failed to fix directory permissions. Error: {}",
            stderr.trim()
        ));
    }
    Ok(())
}

/// Decode the AppleScript string literal inside [`osascript_admin_source`].
/// Fails if a raw `"` terminates the literal early.
#[cfg(test)]
fn decode_admin_script(source: &str) -> Result<String, String> {
    let rest = source
        .strip_prefix("do shell script ")
        .ok_or_else(|| format!("missing prefix: {source}"))?;
    let mut chars = rest.chars();
    if chars.next() != Some('"') {
        return Err(format!("missing opening quote: {source}"));
    }
    let mut out = String::new();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            match chars.next() {
                Some(next) => out.push(next),
                None => return Err("dangling escape".to_string()),
            }
        } else if ch == '"' {
            let tail: String = chars.collect();
            if tail != " with administrator privileges" {
                return Err(format!("unescaped quote broke the literal, tail={tail}"));
            }
            return Ok(out);
        } else {
            out.push(ch);
        }
    }
    Err("unterminated AppleScript string".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn quote_and_backslash_path_has_no_unescaped_double_quote() {
        let path = PathBuf::from("weird\"dir\\name");
        let script = build_mkdir_chown_script(&path, "alice", &path).unwrap();
        assert!(
            script.contains('"'),
            "shell script should still contain the quote"
        );
        assert!(
            script.contains('\\'),
            "shell script should still contain the backslash"
        );
        let source = osascript_admin_source(&script);
        assert!(
            source.contains("\\\""),
            "double quote must be escaped in the osascript argument: {source}"
        );
        assert!(
            source.contains("\\\\"),
            "backslash must be escaped in the osascript argument: {source}"
        );
        let decoded =
            decode_admin_script(&source).expect("AppleScript literal must close only at the end");
        assert_eq!(decoded, script);
    }

    #[test]
    fn apostrophe_does_not_break_the_applescript_string() {
        let path = PathBuf::from("O'Brien's Notes");
        let script = build_mkdir_chown_script(&path, "_svc-agent", &path).unwrap();
        assert!(
            script.contains("'\\''"),
            "POSIX quoting must escape the apostrophe: {script}"
        );
        let source = osascript_admin_source(&script);
        let decoded = decode_admin_script(&source)
            .expect("apostrophe quoting must not split the AppleScript string");
        assert_eq!(decoded, script);
    }

    #[test]
    fn invalid_username_is_not_interpolated() {
        let path = PathBuf::from("/tmp/devprism-elevation");
        for user in [
            "",
            "-lead",
            "9user",
            "bad name",
            "u;rm",
            "u'x",
            "bad;rm -rf /",
            "alice\n",
        ] {
            let err = build_mkdir_chown_script(&path, user, &path).unwrap_err();
            assert!(!err.contains("chown"), "{user:?}: {err}");
            assert!(!err.contains("mkdir"), "{user:?}: {err}");
            if !user.is_empty() {
                assert!(!err.contains(user), "{user:?} was interpolated into: {err}");
            }
        }
        assert!(build_mkdir_chown_script(&path, "alice", &path).is_ok());
    }

    /// Injected command, not `osascript` with administrator privileges.
    #[cfg(unix)]
    #[tokio::test]
    async fn bounded_command_times_out_and_kills_the_child() {
        let dir = tempfile::tempdir().unwrap();
        let pid_path = dir.path().join("child.pid");
        let script = format!(
            "echo $$ > {} ; exec sleep 30",
            shell_single_quote(&pid_path.to_string_lossy())
        );
        let mut cmd = tokio::process::Command::new("sh");
        cmd.arg("-c");
        cmd.arg(&script);
        let err = run_command_bounded(cmd, Duration::from_millis(500))
            .await
            .expect_err("sleep must hit the deadline");
        assert!(
            err.to_lowercase().contains("timed out"),
            "timeout must be reported, got {err}"
        );
        assert!(
            !err.contains("osascript"),
            "the injected command must not be described as osascript: {err}"
        );
        let pid_text =
            std::fs::read_to_string(&pid_path).expect("child should have written its pid");
        let pid: i32 = pid_text.trim().parse().expect("pid");
        assert!(pid > 1, "refusing to treat pid {pid} as the child");
        assert_ne!(pid as u32, std::process::id());
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while pid_alive(pid) && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(
            !pid_alive(pid),
            "kill_on_drop should have killed the injected child {pid}"
        );
    }

    #[test]
    fn newline_quote_and_backslash_do_not_split_the_applescript_literal() {
        let path = PathBuf::from("a\"b\\c'd\nset probeCanary to 1\n");
        let script = build_mkdir_chown_script(&path, "alice", &path).unwrap();
        let source = osascript_admin_source(&script);
        let decoded = decode_admin_script(&source)
            .expect("AppleScript literal must close only at the end");
        assert_eq!(decoded, script);
        assert!(decoded.contains('\n'));
        assert!(decoded.contains('"'));
        assert!(decoded.contains('\\'));
        assert!(decoded.contains("'\\''"));

        let quoted = apple_script_quoted(&script);
        let probe = format!(
            "set s to {quoted}\ntry\nreturn probeCanary as string\non error number n\nreturn \"NO_SPLIT:\" & n\nend try\n"
        );
        assert!(
            !probe.contains("administrator"),
            "the parser probe must not request administrator privileges"
        );
        let dir = tempfile::tempdir().unwrap();
        let probe_path = dir.path().join("probe.applescript");
        std::fs::write(&probe_path, &probe).unwrap();
        let output = std::process::Command::new("osascript")
            .arg(&probe_path)
            .output()
            .expect("osascript");
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stdout.contains("NO_SPLIT"),
            "newline split the AppleScript literal into a second statement\n\
             stdout={stdout}\nstderr={stderr}\nsource={source}"
        );

        let cr_path = PathBuf::from("foo\rset probeCanary to 1\r");
        let cr_script = build_mkdir_chown_script(&cr_path, "alice", &cr_path).unwrap();
        let cr_probe = format!(
            "set s to {}\ntry\nreturn probeCanary as string\non error number n\nreturn \"NO_SPLIT:\" & n\nend try\n",
            apple_script_quoted(&cr_script)
        );
        assert!(!cr_probe.contains("administrator"));
        let cr_path_file = dir.path().join("cr.applescript");
        std::fs::write(&cr_path_file, &cr_probe).unwrap();
        let cr_out = std::process::Command::new("osascript")
            .arg(&cr_path_file)
            .output()
            .expect("osascript");
        let cr_stdout = String::from_utf8_lossy(&cr_out.stdout);
        let cr_stderr = String::from_utf8_lossy(&cr_out.stderr);
        assert!(
            cr_stdout.contains("NO_SPLIT"),
            "carriage return split the AppleScript literal\nstdout={cr_stdout}\nstderr={cr_stderr}"
        );
    }

    #[test]
    fn more_invalid_usernames_are_not_interpolated() {
        let path = PathBuf::from("/tmp/devprism-elevation");
        for user in ["$(id)", "`id`", "a/b", ".hidden", "ä", "alice\r", "a\\b"] {
            let err = build_mkdir_chown_script(&path, user, &path).unwrap_err();
            assert!(!err.contains(user), "{user:?} was interpolated into: {err}");
            assert!(!err.contains("chown"), "{user:?}: {err}");
        }
    }

    /// `kill_on_drop` reaps the direct child. A grandchild it leaves behind is
    /// the residual the brief allowed. This does not run osascript.
    #[cfg(unix)]
    #[tokio::test]
    async fn adv_bounded_command_grandchild_is_residual() {
        let dir = tempfile::tempdir().unwrap();
        let shell_pid_path = dir.path().join("shell.pid");
        let sleep_pid_path = dir.path().join("sleep.pid");
        let script = format!(
            "echo $$ > {} ; sleep 60 & echo $! > {} ; wait",
            shell_single_quote(&shell_pid_path.to_string_lossy()),
            shell_single_quote(&sleep_pid_path.to_string_lossy())
        );
        let mut cmd = tokio::process::Command::new("sh");
        cmd.arg("-c");
        cmd.arg(&script);
        let err = run_command_bounded(cmd, Duration::from_millis(500))
            .await
            .expect_err("the waiting shell must hit the deadline");
        assert!(
            err.to_lowercase().contains("timed out"),
            "timeout must be reported, got {err}"
        );
        let shell_pid: i32 = std::fs::read_to_string(&shell_pid_path)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let sleep_pid: i32 = std::fs::read_to_string(&sleep_pid_path)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert!(shell_pid > 1 && sleep_pid > 1);
        assert_ne!(shell_pid as u32, std::process::id());
        assert_ne!(sleep_pid as u32, std::process::id());
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while pid_alive(shell_pid) && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(
            !pid_alive(shell_pid),
            "direct child {shell_pid} survived kill_on_drop"
        );
        let survived = pid_alive(sleep_pid);
        if survived && sleep_pid > 1 {
            unsafe {
                libc::kill(sleep_pid, libc::SIGKILL);
            }
        }
        eprintln!(
            "F-7 residual: run_command_bounded grandchild survived={survived} pid={sleep_pid}"
        );
        let _ = std::fs::create_dir_all("/tmp/wave4-results");
        let _ = std::fs::write(
            "/tmp/wave4-results/f7-grandchild.txt",
            format!("survived={survived} pid={sleep_pid}\n"),
        );
    }

    #[cfg(unix)]
    fn pid_alive(pid: i32) -> bool {
        if pid <= 0 {
            return false;
        }
        let rc = unsafe { libc::kill(pid, 0) };
        if rc == 0 {
            return true;
        }
        std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }
}
