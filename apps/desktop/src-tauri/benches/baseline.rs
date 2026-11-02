//! Baseline numbers for the in-process Typst compile and the JSON IPC shape.
//!
//! `harness = false` so this is an ordinary binary timed with `std::time`.
//! Criterion is not a dependency. The deadline is the harness's: a compile
//! that does not return fails the process. It does not change the engine.

#[path = "../tests/bench_deadline.rs"]
mod deadline;

use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::{Duration, Instant};

use claude_prism_desktop_lib::career_typst::engine::{
    compile_resume_pdf, TypstCompileResult,
};

const THIRTY_PAGE: &str = include_str!("fixtures/thirty-page.typ");
const ONE_PAGE: &str = "\
#set page(paper: \"a4\", margin: 1.5cm)\n\
#set text(font: \"Libertinus Serif\", size: 11pt)\n\
= Bench\n\
One synthetic page for the in-process compile baseline.\n";

/// A compile that is still running after this is a hang, not a sample.
const COMPILE_DEADLINE: Duration = Duration::from_secs(120);
const WARM_SAMPLES: usize = 7;

struct Samples {
    min_ms: f64,
    max_ms: f64,
    spread_ms: f64,
    samples_ms: Vec<f64>,
    first_call_ms: f64,
}

fn main() -> ExitCode {
    if !deadline::hang_is_not_a_value() || !deadline::finished_work_is_a_value() {
        eprintln!("bench deadline self-check failed; no measurement was recorded");
        return ExitCode::from(1);
    }
    if env::args().any(|arg| arg == "--self-test") {
        println!("deadline self-check passed");
        return ExitCode::from(0);
    }

    let smoke = env::var("BENCH_SMOKE").ok().as_deref() == Some("1")
        || env::args().any(|arg| arg == "--smoke");
    let n = if smoke { 1 } else { WARM_SAMPLES };

    let thirty = match measure("thirty-page", THIRTY_PAGE, n, 30) {
        Ok(value) => value,
        Err(err) => {
            eprintln!("thirty-page compile was not measured: {err}");
            let _ = write_report(&serde_json::json!({
                "status": "not_measured",
                "reason": err,
            }));
            return ExitCode::from(1);
        }
    };
    let one = match measure("one-page", ONE_PAGE, n, 1) {
        Ok(value) => value,
        Err(err) => {
            eprintln!("one-page compile was not measured: {err}");
            let _ = write_report(&serde_json::json!({
                "thirty_page": samples_json(&thirty.samples),
                "one_page": { "status": "not_measured", "reason": err },
            }));
            return ExitCode::from(1);
        }
    };

    let ipc = match ipc_shape(&thirty.result) {
        Ok(value) => value,
        Err(err) => {
            eprintln!("ipc shape was not measured: {err}");
            return ExitCode::from(1);
        }
    };

    let pdf_path = pdf_out_path();
    if let Some(parent) = pdf_path.parent() {
        if let Err(err) = fs::create_dir_all(parent) {
            eprintln!("could not create {}: {err}", parent.display());
            return ExitCode::from(1);
        }
    }
    let pdf = match thirty.result.pdf_bytes.as_ref() {
        Some(bytes) => bytes,
        None => {
            eprintln!("thirty-page compile reported success without pdf bytes");
            return ExitCode::from(1);
        }
    };
    if let Err(err) = fs::write(&pdf_path, pdf) {
        eprintln!("could not write {}: {err}", pdf_path.display());
        return ExitCode::from(1);
    }

    let report = serde_json::json!({
        "status": "measured",
        "smoke": smoke,
        "deadline_ms": COMPILE_DEADLINE.as_millis(),
        "deadline_self_check": "a worker that slept past the deadline returned Exceeded before the worker finished",
        "api": "career_typst::engine::compile_resume_pdf",
        "warmup_excluded": if smoke { 0 } else { 1 },
        "note": "min_ms is the minimum of the same-config reruns after one warmup compile. That warmup is recorded as first_call_ms (font discovery included) and is not part of the spread. In smoke mode the single run is the only sample and is not a noise floor. compile_resume_pdf returns the full PDF; it does not stop at the first page.",
        "thirty_page": samples_json(&thirty.samples),
        "one_page": samples_json(&one.samples),
        "ipc": ipc,
        "pdf_path": pdf_path,
    });
    if let Err(err) = write_report(&report) {
        eprintln!("{err}");
        return ExitCode::from(1);
    }
    println!("{}", report);
    ExitCode::from(0)
}

struct Measured {
    samples: Samples,
    result: TypstCompileResult,
}

fn measure(label: &str, source: &str, n: usize, expect_pages: usize) -> Result<Measured, String> {
    let first = compile_once(label, source, expect_pages)?;
    let first_call_ms = first.0;
    let result = if n == 1 {
        return Ok(Measured {
            samples: Samples {
                min_ms: first_call_ms,
                max_ms: first_call_ms,
                spread_ms: 0.0,
                samples_ms: vec![first_call_ms],
                first_call_ms,
            },
            result: first.1,
        });
    } else {
        first.1
    };

    let mut samples_ms = Vec::with_capacity(n);
    let mut last = result;
    for index in 0..n {
        let (ms, compiled) = compile_once(label, source, expect_pages)?;
        samples_ms.push(ms);
        last = compiled;
        eprintln!("{label} sample {index}: {ms:.3} ms");
    }
    let min_ms = samples_ms.iter().copied().fold(f64::INFINITY, f64::min);
    let max_ms = samples_ms.iter().copied().fold(0.0_f64, f64::max);
    Ok(Measured {
        samples: Samples {
            min_ms,
            max_ms,
            spread_ms: max_ms - min_ms,
            samples_ms,
            first_call_ms,
        },
        result: last,
    })
}

fn compile_once(
    label: &str,
    source: &str,
    expect_pages: usize,
) -> Result<(f64, TypstCompileResult), String> {
    let owned = source.to_string();
    // Time the compile on the worker. The thread handoff is harness overhead
    // and is not the in-process compile.
    let (elapsed_ms, compiled) = deadline::run_with_deadline(COMPILE_DEADLINE, move || {
        let started = Instant::now();
        let compiled = compile_resume_pdf(&owned);
        (started.elapsed().as_secs_f64() * 1000.0, compiled)
    })
    .map_err(|err| match err {
        deadline::DeadlineError::Exceeded { deadline_ms } => format!(
            "{label} compile did not return within {deadline_ms} ms; the harness failed the hang and recorded no duration"
        ),
        deadline::DeadlineError::WorkerStopped => {
            format!("{label} compile worker stopped without a result")
        }
    })?;
    if !compiled.success {
        let message = compiled
            .errors
            .first()
            .map(|err| err.message.clone())
            .unwrap_or_else(|| "compile failed".to_string());
        return Err(format!("{label} compile failed: {message}"));
    }
    if compiled.page_count != expect_pages {
        return Err(format!(
            "{label} compiled to {} pages, expected {expect_pages}",
            compiled.page_count
        ));
    }
    let pdf = compiled
        .pdf_bytes
        .as_ref()
        .ok_or_else(|| format!("{label} compile succeeded without pdf bytes"))?;
    if !pdf.starts_with(b"%PDF-") {
        return Err(format!("{label} output does not start with %PDF-"));
    }
    Ok((elapsed_ms, compiled))
}

fn ipc_shape(result: &TypstCompileResult) -> Result<serde_json::Value, String> {
    let pdf = result
        .pdf_bytes
        .as_ref()
        .ok_or_else(|| "no pdf bytes to encode".to_string())?;
    let field = serde_json::to_vec(pdf).map_err(|err| format!("serde_json of pdf bytes: {err}"))?;
    let full = serde_json::to_vec(result).map_err(|err| format!("serde_json of result: {err}"))?;
    // serde_json encodes Vec<u8> as a JSON array of numbers. The first PDF
    // byte is '%' (37), so the array opens with `[37,` or `[37]`.
    let looks_like_number_array = field.starts_with(b"[37,") || field.starts_with(b"[37]");
    if !looks_like_number_array {
        return Err(format!(
            "pdf bytes did not serialize as a JSON number array (prefix {:?})",
            String::from_utf8_lossy(&field[..field.len().min(16)])
        ));
    }
    Ok(serde_json::json!({
        "status": "measured",
        "shape": "json_number_array",
        "api": "career_typst_compile returns TypstCompileResult. pdf_bytes is Option<Vec<u8>>. This commit also has typst_compile_document, which returns tauri::ipc::Response. That Response path was not measured.",
        "pdf_byte_length": pdf.len(),
        "json_number_array_byte_length": field.len(),
        "result_json_byte_length": full.len(),
        "ratio_array_over_pdf": (field.len() as f64) / (pdf.len() as f64),
    }))
}

fn samples_json(samples: &Samples) -> serde_json::Value {
    serde_json::json!({
        "status": "measured",
        "n": samples.samples_ms.len(),
        "min_ms": samples.min_ms,
        "max_ms": samples.max_ms,
        "spread_ms": samples.spread_ms,
        "samples_ms": samples.samples_ms,
        "first_call_ms": samples.first_call_ms,
        "unit": "ms",
    })
}

fn pdf_out_path() -> PathBuf {
    env::var_os("DEVPRISM_BENCH_PDF")
        .map(PathBuf::from)
        .unwrap_or_else(|| repo_bench_results().join("thirty-page.pdf"))
}

fn report_path() -> PathBuf {
    env::var_os("DEVPRISM_BENCH_RUST_JSON")
        .map(PathBuf::from)
        .unwrap_or_else(|| repo_bench_results().join("rust-partial.json"))
}

fn repo_bench_results() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../bench-results")
}

fn write_report(value: &serde_json::Value) -> Result<(), String> {
    let path = report_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("create {}: {err}", parent.display()))?;
    }
    let body = serde_json::to_vec_pretty(value)
        .map_err(|err| format!("serialize report: {err}"))?;
    fs::write(&path, body).map_err(|err| format!("write {}: {err}", path.display()))?;
    Ok(())
}
