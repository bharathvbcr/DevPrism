//! The benchmark deadline lives in the bench crate. This test links the same
//! file so `cargo test` fails when a hang is reported as a finished value.

#[path = "bench_deadline.rs"]
mod deadline;

#[test]
fn a_hang_is_not_a_successful_measurement() {
    assert!(
        deadline::hang_is_not_a_value(),
        "a worker that does not return must not look like a finished measurement"
    );
}

#[test]
fn a_finished_worker_is_a_value() {
    assert!(
        deadline::finished_work_is_a_value(),
        "work that returns inside the deadline must come back as that value"
    );
}
