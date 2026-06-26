import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createAutoCompileScheduler,
  AUTO_COMPILE_DEBOUNCE_MS,
} from "@/lib/auto-compile";

const ready = (generation: number, enabled = true) => ({
  enabled,
  ready: true,
  generation,
});

describe("createAutoCompileScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not compile when enabled without an edit", () => {
    const compile = vi.fn();
    const s = createAutoCompileScheduler(compile);

    s.sync(ready(0)); // establishes baseline, no compile
    vi.advanceTimersByTime(AUTO_COMPILE_DEBOUNCE_MS * 2);

    expect(compile).not.toHaveBeenCalled();
  });

  it("compiles exactly once after a single edit settles", () => {
    const compile = vi.fn();
    const s = createAutoCompileScheduler(compile);

    s.sync(ready(0)); // baseline
    s.sync(ready(1)); // edit → arm debounce

    vi.advanceTimersByTime(AUTO_COMPILE_DEBOUNCE_MS - 1);
    expect(compile).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(compile).toHaveBeenCalledTimes(1);
  });

  it("coalesces a burst of edits into a single compile", () => {
    const compile = vi.fn();
    const s = createAutoCompileScheduler(compile);

    s.sync(ready(0)); // baseline
    s.sync(ready(1));
    vi.advanceTimersByTime(500);
    s.sync(ready(2));
    vi.advanceTimersByTime(500);
    s.sync(ready(3));

    // Each edit re-armed the timer; nothing fired during the burst.
    expect(compile).not.toHaveBeenCalled();

    vi.advanceTimersByTime(AUTO_COMPILE_DEBOUNCE_MS);
    expect(compile).toHaveBeenCalledTimes(1);
  });

  it("does not compile while disabled", () => {
    const compile = vi.fn();
    const s = createAutoCompileScheduler(compile);

    s.sync({ enabled: false, ready: true, generation: 0 });
    s.sync({ enabled: false, ready: true, generation: 1 });
    vi.advanceTimersByTime(AUTO_COMPILE_DEBOUNCE_MS * 2);

    expect(compile).not.toHaveBeenCalled();
  });

  it("cancels a pending compile when disabled mid-debounce", () => {
    const compile = vi.fn();
    const s = createAutoCompileScheduler(compile);

    s.sync(ready(0)); // baseline
    s.sync(ready(1)); // arm debounce
    vi.advanceTimersByTime(500);
    s.sync({ enabled: false, ready: true, generation: 1 }); // turn off

    vi.advanceTimersByTime(AUTO_COMPILE_DEBOUNCE_MS * 2);
    expect(compile).not.toHaveBeenCalled();
  });

  it("re-establishes a baseline after being re-enabled (no compile on toggle)", () => {
    const compile = vi.fn();
    const s = createAutoCompileScheduler(compile);

    s.sync(ready(5)); // baseline at 5
    s.sync({ enabled: false, ready: true, generation: 9 }); // off, baseline reset
    s.sync(ready(9)); // on again → new baseline at 9, no compile

    vi.advanceTimersByTime(AUTO_COMPILE_DEBOUNCE_MS * 2);
    expect(compile).not.toHaveBeenCalled();

    s.sync(ready(10)); // a real edit now
    vi.advanceTimersByTime(AUTO_COMPILE_DEBOUNCE_MS);
    expect(compile).toHaveBeenCalledTimes(1);
  });

  it("does not establish a baseline until the project is ready", () => {
    const compile = vi.fn();
    const s = createAutoCompileScheduler(compile);

    // Edits arrive before the project is ready — must be ignored for baseline.
    s.sync({ enabled: true, ready: false, generation: 3 });
    s.sync(ready(3)); // first ready call establishes baseline at 3
    vi.advanceTimersByTime(AUTO_COMPILE_DEBOUNCE_MS);
    expect(compile).not.toHaveBeenCalled();

    s.sync(ready(4));
    vi.advanceTimersByTime(AUTO_COMPILE_DEBOUNCE_MS);
    expect(compile).toHaveBeenCalledTimes(1);
  });

  it("dispose cancels a pending compile", () => {
    const compile = vi.fn();
    const s = createAutoCompileScheduler(compile);

    s.sync(ready(0));
    s.sync(ready(1));
    vi.advanceTimersByTime(500);
    s.dispose();

    vi.advanceTimersByTime(AUTO_COMPILE_DEBOUNCE_MS * 2);
    expect(compile).not.toHaveBeenCalled();
  });

  it("respects a custom debounce interval", () => {
    const compile = vi.fn();
    const s = createAutoCompileScheduler(compile, 300);

    s.sync(ready(0));
    s.sync(ready(1));
    vi.advanceTimersByTime(299);
    expect(compile).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(compile).toHaveBeenCalledTimes(1);
  });
});
