import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { createElement } from "react";

/**
 * Instrumentation for optimization #2 (MarkdownRenderer memoization).
 *
 * The claims under test:
 * 1. Re-rendering a stable message does NOT re-run the markdown pipeline.
 * 2. A streaming delta re-parses only the message that changed — neighbors
 *    in the same thread contribute zero additional parses.
 * 3. The memo wrapper still renders real content through the real
 *    remark/rehype/KaTeX pipeline.
 *
 * Parse count is the mechanistic proxy: each ReactMarkdown invocation rebuilds
 * the unified processor and parses the full message body, which dominated CPU
 * during long streaming replies before memoization.
 */

const mdInvocations = vi.hoisted(() => ({ value: 0 }));

vi.mock("react-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-markdown")>();
  const RealMarkdown = actual.default;
  const CountingMarkdown = (props: Record<string, unknown>) => {
    mdInvocations.value += 1;
    return createElement(RealMarkdown, props);
  };
  return { __esModule: true, default: CountingMarkdown };
});

import { MarkdownRenderer } from "@/components/claude-chat/markdown-renderer";

/** Minimal stand-in for the chat thread mapping messages → bubbles. */
function Thread({ messages }: { messages: string[] }) {
  return createElement(
    "div",
    null,
    messages.map((m, i) =>
      createElement(MarkdownRenderer, { key: i, content: m }),
    ),
  );
}

describe("instrumentation #2: markdown parse counts", () => {
  it("stable props never re-parse: 20 parent re-renders → still 1 parse", () => {
    mdInvocations.value = 0;
    const content = "# Hello\n\nSome *formatted* body text.";
    const { rerender } = render(createElement(Thread, { messages: [content] }));
    expect(mdInvocations.value).toBe(1);

    for (let i = 0; i < 20; i++) {
      // Parent re-renders (new element identity, same prop values) — exactly
      // what happens when a sibling streams or a tool result map rebuilds.
      rerender(createElement(Thread, { messages: [content] }));
    }
    expect(mdInvocations.value).toBe(1);
  });

  it("streaming one bubble re-parses only that bubble", () => {
    mdInvocations.value = 0;
    const stableA = "- item one";
    const stableB = "| col | col |\n| --- | --- |\n| a | b |";
    let streaming = "partial answer";

    const { rerender } = render(
      createElement(Thread, { messages: [stableA, stableB, streaming] }),
    );
    const afterInitial = mdInvocations.value;
    expect(afterInitial).toBe(3);

    // 30 stream deltas replace the last message object, like the store does.
    for (let i = 0; i < 30; i++) {
      streaming = `${streaming} word${i}`;
      rerender(
        createElement(Thread, { messages: [stableA, stableB, streaming] }),
      );
    }

    const parsedDuringStream = mdInvocations.value - afterInitial;
    // Exactly one parse per delta — the two stable neighbors never re-parse.
    expect(parsedDuringStream).toBe(30);
    expect(mdInvocations.value).toBe(33);
  });

  it("renders real content through the real pipeline (math included)", () => {
    mdInvocations.value = 0;
    const { container } = render(
      createElement(MarkdownRenderer, {
        content: "Euler says $E = mc^2$ and $\\int_0^1 x\\,dx$.",
      }),
    );
    // KaTeX output carries the formula text into the DOM.
    expect(container.textContent).toContain("E=mc");
    expect(container.textContent).toContain("∫"); // rendered integral glyph
    expect(mdInvocations.value).toBeGreaterThanOrEqual(1);
  });
});
