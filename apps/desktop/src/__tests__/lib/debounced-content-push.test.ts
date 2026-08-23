import { describe, expect, it, vi } from "vitest";
import { createDebouncedContentPush } from "@/lib/editor/debounced-content-push";

describe("createDebouncedContentPush", () => {
  it("coalesces rapid schedules into one trailing commit", () => {
    vi.useFakeTimers();
    const commit = vi.fn();
    const push = createDebouncedContentPush(150, commit);

    push.schedule("main.tex", "a");
    push.schedule("main.tex", "ab");
    push.schedule("main.tex", "abc");
    expect(commit).not.toHaveBeenCalled();

    // A single trailing snapshot lands with the latest content.
    vi.advanceTimersByTime(150);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith("main.tex", "abc");
    vi.useRealTimers();
  });

  it("flush() commits queued content immediately", () => {
    const commit = vi.fn();
    const push = createDebouncedContentPush(150, commit);
    push.schedule("main.tex", "hello");
    push.flush();
    expect(commit).toHaveBeenCalledWith("main.tex", "hello");
    // Flushing twice without new content is a no-op.
    push.flush();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("cancel() drops queued content without committing", () => {
    vi.useFakeTimers();
    const commit = vi.fn();
    const push = createDebouncedContentPush(150, commit);
    push.schedule("main.tex", "typed");
    push.cancel();
    vi.advanceTimersByTime(500);
    expect(commit).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("hasPending() tracks queued files per file and clears on flush/cancel", () => {
    vi.useFakeTimers();
    const commit = vi.fn();
    const push = createDebouncedContentPush(150, commit);
    expect(push.hasPending("main.tex")).toBe(false);
    push.schedule("main.tex", "a");
    push.schedule("other.tex", "b");
    expect(push.hasPending("main.tex")).toBe(true);
    expect(push.hasPending("other.tex")).toBe(true);
    push.flush();
    expect(push.hasPending("main.tex")).toBe(false);
    expect(push.hasPending("other.tex")).toBe(false);
    vi.useRealTimers();
  });

  it("scheduling a second file does not drop the first file's pending content", () => {
    // Regression: the single-slot implementation lost file A's keystrokes
    // when file B was scheduled within the same interval.
    vi.useFakeTimers();
    const commit = vi.fn();
    const push = createDebouncedContentPush(150, commit);
    push.schedule("a.tex", "A-typed");
    push.schedule("b.tex", "B-typed");
    push.flush();
    expect(commit).toHaveBeenCalledWith("a.tex", "A-typed");
    expect(commit).toHaveBeenCalledWith("b.tex", "B-typed");
    vi.useRealTimers();
  });

  it("continuous typing keeps pushing snapshots at the interval", () => {
    vi.useFakeTimers();
    const commit = vi.fn();
    const push = createDebouncedContentPush(150, commit);

    for (let i = 1; i <= 10; i++) {
      push.schedule("main.tex", "content".slice(0, Math.max(i, 7)));
      vi.advanceTimersByTime(50);
    }
    // 500ms of typing at 50ms keystrokes → commits at ~150/300/450ms.
    expect(commit).toHaveBeenCalledTimes(3);
    expect(commit).toHaveBeenLastCalledWith("main.tex", "content");
    vi.useRealTimers();
  });
});
