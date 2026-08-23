import { describe, expect, it } from "vitest";
import type {
  ClaudeStreamMessage,
  ContentBlock,
} from "@/stores/claude-chat-store";
import {
  buildDisplayEntries,
  buildToolResultMap,
  isToolResultOnlyUserMessage,
  stabilizeToolResultMap,
} from "@/lib/chat-message-display";

/**
 * Fuzz harness for the extracted transcript derivations.
 *
 * The naive references below are VERBATIM copies of the logic that lived in
 * `ChatMessages` before extraction (three passes + indexOf + backward scans).
 * The extracted implementation must produce byte-identical outcomes across
 * randomized message streams — including every weird shape the old filter
 * tolerated.
 */

// ─── Naive references (verbatim originals) ───

function referenceDisplayMessages(messages: ClaudeStreamMessage[]) {
  const assistantTexts = new Set<string>();
  for (const msg of messages) {
    if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
      for (const block of msg.message.content) {
        if (block.type === "text" && block.text) {
          assistantTexts.add(block.text.trim());
        }
      }
    }
  }

  return messages.filter((msg) => {
    if (msg.type === "system" && msg.subtype === "init") return false;
    if (
      msg.type === "assistant" &&
      (msg.subtype === "context_truncation" ||
        msg.subtype === "context_compaction")
    ) {
      return false;
    }
    if (
      msg.type !== "user" &&
      msg.type !== "assistant" &&
      msg.type !== "result"
    )
      return false;
    if (msg.type === "user" && msg.message?.content) {
      if (Array.isArray(msg.message.content)) {
        const hasOnlyToolResults = msg.message.content.every(
          (b: ContentBlock) => b.type === "tool_result",
        );
        if (hasOnlyToolResults) return false;
      }
    }
    if (msg.type === "result" && msg.result) {
      if (assistantTexts.has(msg.result.trim())) return false;
    }
    return true;
  });
}

function referenceDecorate(messages: ClaudeStreamMessage[]) {
  return referenceDisplayMessages(messages).map((msg) => {
    const rawIndex = messages.indexOf(msg);
    let precedingUserIndex = -1;
    for (let i = rawIndex; i >= 0; i--) {
      if (messages[i]?.type === "user") {
        precedingUserIndex = i;
        break;
      }
    }
    return { msg, rawIndex, precedingUserIndex };
  });
}

function referenceToolResultMap(messages: ClaudeStreamMessage[]) {
  const map = new Map<string, ContentBlock>();
  for (const msg of messages) {
    if (msg.type === "user" && Array.isArray(msg.message?.content)) {
      for (const block of msg.message.content) {
        if (block.type === "tool_result" && block.tool_use_id) {
          map.set(block.tool_use_id, block);
        }
      }
    }
  }
  return map;
}

// ─── Seeded generator ───

function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Generate a realistic-but-random transcript; returns messages plus the
 *  text pool used so results can exactly match assistant texts. */
function generateStream(rng: () => number, maxLen: number) {
  const messages: ClaudeStreamMessage[] = [];
  const textPool: string[] = [];
  const toolIds: string[] = [];
  const len = 1 + Math.floor(rng() * maxLen);

  const pushText = () => {
    // Sometimes whitespace-only (trims to ""), sometimes real prose.
    const text =
      rng() < 0.15
        ? "   ".repeat(1 + Math.floor(rng() * 2))
        : `body ${Math.floor(rng() * 1e9)}`;
    textPool.push(text);
    return [{ type: "text" as const, text }];
  };

  for (let i = 0; i < len; i++) {
    const roll = rng();
    if (roll < 0.05) {
      messages.push({ type: "system", subtype: "init", session_id: "s" });
    } else if (roll < 0.2) {
      messages.push({
        type: "user",
        message: {
          content: [...pushText(), ...(rng() < 0.2 ? pushText() : [])],
        },
      });
    } else if (roll < 0.25) {
      // Non-array or missing content (old filter kept these).
      messages.push(
        rng() < 0.5
          ? { type: "user", message: { content: "plain string" as never } }
          : { type: "user" },
      );
    } else if (roll < 0.45) {
      messages.push({ type: "assistant", message: { content: pushText() } });
    } else if (roll < 0.55) {
      const id = `toolu_${i}`;
      toolIds.push(id);
      messages.push({
        type: "assistant",
        message: {
          content: [
            ...pushText(),
            { type: "tool_use" as const, id, name: "Read", input: {} },
          ],
        },
      });
    } else if (roll < 0.7 && toolIds.length > 0) {
      // Tool-result-only user turn (must be filtered out).
      const id = toolIds[Math.floor(rng() * toolIds.length)];
      messages.push({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result" as const,
              tool_use_id: id,
              content: `out ${Math.floor(rng() * 1e6)}`,
            },
          ],
        },
      });
    } else if (roll < 0.78) {
      // Mixed user content (kept — not tool-result-only).
      const base: ContentBlock[] = [...pushText()];
      if (toolIds.length > 0) {
        const id = toolIds[Math.floor(rng() * toolIds.length)];
        base.push({
          type: "tool_result",
          tool_use_id: id,
          content: "mixed payload",
        });
      }
      messages.push({ type: "user", message: { content: base } });
    } else if (roll < 0.86) {
      messages.push({
        type: "assistant",
        subtype: rng() < 0.5 ? "context_truncation" : "context_compaction",
        message: { content: pushText() },
      });
    } else if (roll < 0.93 && textPool.length > 0) {
      // Result echoing an existing assistant text verbatim (deduped).
      const text = textPool[Math.floor(rng() * textPool.length)];
      messages.push({ type: "result", result: text });
    } else {
      // Fresh result text, sometimes empty/whitespace.
      messages.push({
        type: "result",
        result: rng() < 0.3 ? "" : `final ${Math.floor(rng() * 1e9)}`,
      });
    }
    // Occasional empty-content user (every() on [] is true → filtered).
    if (rng() < 0.04) {
      messages.push({ type: "user", message: { content: [] } });
    }
  }
  return messages;
}

describe("stress/fuzz: chat display derivations vs original logic", () => {
  it("200 seeded streams produce identical output to the naive reference", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rng = makeRng(seed);
      const messages = generateStream(rng, 40);

      const expected = referenceDecorate(messages);
      const actual = buildDisplayEntries(messages);

      expect(actual.length).toBe(expected.length);
      for (let i = 0; i < expected.length; i++) {
        expect(actual[i].msg).toBe(expected[i].msg);
        expect(actual[i].rawIndex).toBe(expected[i].rawIndex);
        expect(actual[i].precedingUserIndex).toBe(
          expected[i].precedingUserIndex,
        );
      }

      const expectedMap = referenceToolResultMap(messages);
      const actualMap = buildToolResultMap(messages);
      expect(actualMap.size).toBe(expectedMap.size);
      for (const [key, value] of expectedMap) {
        expect(actualMap.get(key)).toBe(value);
      }
    }
  });

  it("appending messages never shifts earlier raw indices", () => {
    const rng = makeRng(7);
    const stream = generateStream(rng, 20);
    const before = buildDisplayEntries(stream);

    // Simulate streaming: append several messages (deltas replace the tail,
    // new turns append).
    const grown = [
      ...stream,
      {
        type: "assistant" as const,
        message: { content: [{ type: "text" as const, text: "more" }] },
      },
      { type: "result" as const, result: "more" },
    ];
    const after = buildDisplayEntries(grown);

    for (let i = 0; i < before.length; i++) {
      const counterpart = after.find((e) => e.msg === before[i].msg);
      expect(counterpart).toBeDefined();
      expect(counterpart!.rawIndex).toBe(before[i].rawIndex);
    }
  });
});

describe("stabilizeToolResultMap identity semantics", () => {
  it("returns the previous object when contents are identical", () => {
    const block: ContentBlock = { type: "tool_result", tool_use_id: "t1" };
    const prev = new Map([["t1", block]]);
    const next = new Map([["t1", block]]);
    expect(stabilizeToolResultMap(prev, next)).toBe(prev);
  });

  it("returns next when a value differs or size changes", () => {
    const prev = new Map([
      ["t1", { type: "tool_result" as const, tool_use_id: "t1" }],
    ]);
    const changed = new Map([
      [
        "t1",
        { type: "tool_result" as const, tool_use_id: "t1", is_error: true },
      ],
    ]);
    expect(stabilizeToolResultMap(prev, changed)).toBe(changed);

    const bigger = new Map<string, ContentBlock>([
      ...changed,
      ["t2", { type: "tool_result", tool_use_id: "t2" }],
    ]);
    expect(stabilizeToolResultMap(prev, bigger)).toBe(bigger);
  });

  it("per-delta rebuilds with unchanged contents keep one identity", () => {
    // The exact hot-path scenario: messages array replaced per delta while
    // tool results stay put → map identity stays stable → memoized bubbles
    // do not re-render.
    const block: ContentBlock = { type: "tool_result", tool_use_id: "x" };
    const msgsA: ClaudeStreamMessage[] = [
      { type: "user", message: { content: [block] } },
    ];
    const msgsB: ClaudeStreamMessage[] = [
      { type: "user", message: { content: [block] } },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "delta" }] },
      },
    ];

    let current = buildToolResultMap(msgsA);
    const first = current;
    current = stabilizeToolResultMap(current, buildToolResultMap(msgsA));
    expect(current).toBe(first);
    // msgsB appends an assistant delta; tool results unchanged → same map.
    current = stabilizeToolResultMap(current, buildToolResultMap(msgsB));
    expect(current).toBe(first);
  });
});

describe("isToolResultOnlyUserMessage edges", () => {
  it("mirrors the original guard exactly", () => {
    expect(isToolResultOnlyUserMessage({ type: "assistant" })).toBe(false);
    expect(isToolResultOnlyUserMessage({ type: "user" })).toBe(false);
    expect(
      isToolResultOnlyUserMessage({
        type: "user",
        message: { content: "string" as never },
      }),
    ).toBe(false);
    // [].every(...) === true — the original filtered these too.
    expect(
      isToolResultOnlyUserMessage({ type: "user", message: { content: [] } }),
    ).toBe(true);
    expect(
      isToolResultOnlyUserMessage({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "a" },
            { type: "tool_result", tool_use_id: "b" },
          ],
        },
      }),
    ).toBe(true);
    expect(
      isToolResultOnlyUserMessage({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "a" },
            { type: "text", text: "hi" },
          ],
        },
      }),
    ).toBe(false);
  });
});

// ─── Golden transcripts: hand-reasoned expectations ───
//
// Each fixture's expected output was written from the UI contract ("what a
// reader should see"), NOT derived from either implementation. Asserting
// against both `buildDisplayEntries` and `referenceDecorate` pins impl and
// transcribed reference to the same human intent — a shared misreading of
// the original code would surface here as disagreement with these literals.

describe("golden transcripts", () => {
  const txt = (text: string): ContentBlock => ({ type: "text", text });
  const userMsg = (text: string): ClaudeStreamMessage => ({
    type: "user",
    message: { content: [txt(text)] },
  });
  const assistantMsg = (...blocks: ContentBlock[]): ClaudeStreamMessage => ({
    type: "assistant",
    message: { content: blocks },
  });
  const resultMsg = (result: string): ClaudeStreamMessage => ({
    type: "result",
    result,
  });

  /** Triple check: impl output equals literal expectation AND reference. */
  function expectGolden(
    messages: ClaudeStreamMessage[],
    expected: Array<[number, string, number]>,
  ) {
    const got = buildDisplayEntries(messages);
    expect(
      got.map((e) => [e.rawIndex, e.msg.type, e.precedingUserIndex]),
    ).toEqual(expected);
    const ref = referenceDecorate(messages);
    expect(ref.map((e) => e.rawIndex)).toEqual(expected.map(([i]) => i));
  }

  it("G1: simple Q&A — result echoing the answer is suppressed", () => {
    expectGolden(
      [
        userMsg("What is enthalpy?"),
        assistantMsg(txt("Enthalpy is a state function.")),
        resultMsg("Enthalpy is a state function."),
      ],
      [
        [0, "user", 0],
        [1, "assistant", 0],
      ],
    );
  });

  it("G2: tool round-trip — inline results hidden, deduped result hidden", () => {
    expectGolden(
      [
        userMsg("Read the intro chapter"),
        assistantMsg(txt("Checking…"), {
          type: "tool_use",
          id: "t1",
          name: "Read",
          input: {},
        }),
        {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "t1",
                content: "...intro...",
              },
            ],
          },
        },
        assistantMsg(txt("Intro says entropy increases.")),
        resultMsg("Intro says entropy increases."),
      ],
      [
        [0, "user", 0],
        [1, "assistant", 0],
        // Anchor contract: precedingUserIndex scans the RAW messages array,
        // so the HIDDEN tool-result turn at index 2 is still the regenerate
        // anchor — "regenerate" resumes from after the tool ran. Both the
        // extracted impl and the transcribed reference agree; this golden
        // pins that subtle behavior explicitly.
        [3, "assistant", 2],
      ],
    );
  });

  it("G3: system init and context notices never render", () => {
    expectGolden(
      [
        { type: "system", subtype: "init" },
        { type: "assistant", subtype: "context_truncation" },
        userMsg("question"),
        { type: "assistant", subtype: "context_compaction" },
        assistantMsg(txt("answer")),
      ],
      [
        [2, "user", 2],
        [4, "assistant", 2],
      ],
    );
  });

  it("G4: a result that matches nothing stays visible as its own turn", () => {
    expectGolden(
      [
        userMsg("draft something"),
        assistantMsg(txt("rough draft")),
        resultMsg("Polished final answer."),
      ],
      [
        [0, "user", 0],
        [1, "assistant", 0],
        [2, "result", 0],
      ],
    );
  });

  it("G5: multi-turn anchors track the nearest preceding user", () => {
    expectGolden(
      [
        userMsg("A"),
        assistantMsg(txt("a1")),
        resultMsg("a1"),
        userMsg("B"),
        assistantMsg(txt("b1")),
        resultMsg("b1"),
        userMsg("C"),
        assistantMsg(txt("c1")),
        resultMsg("OTHER"),
      ],
      [
        [0, "user", 0],
        [1, "assistant", 0],
        [3, "user", 3],
        [4, "assistant", 3],
        [6, "user", 6],
        [7, "assistant", 6],
        [8, "result", 6],
      ],
    );
  });

  it("G6: empty-string result is kept — locks original truthiness semantics", () => {
    // The whitespace-only assistant text trims into the dedup set, but an
    // EMPTY result string is falsy in the original guard, so it never even
    // consults the set. This golden documents that behavior deliberately.
    expectGolden(
      [assistantMsg(txt("   ")), resultMsg("")],
      [
        [0, "assistant", -1],
        [1, "result", -1],
      ],
    );
  });
});

// ─── Scale: 2000-message transcript ───

describe("stress/scale: 2000-message transcript", () => {
  it("matches the reference and completes within budget", () => {
    const rng = makeRng(2024);
    const messages = generateStream(rng, 2000);
    expect(messages.length).toBeGreaterThan(1500);

    const started = performance.now();
    const got = buildDisplayEntries(messages);
    const elapsedMs = performance.now() - started;

    const expected = referenceDecorate(messages);
    expect(got.length).toBe(expected.length);
    for (let i = 0; i < expected.length; i++) {
      expect(got[i].msg).toBe(expected[i].msg);
      expect(got[i].rawIndex).toBe(expected[i].rawIndex);
    }
    // Generous CI-safe budget: the derivation is O(n); a quadratic blow-up
    // would exceed this by orders of magnitude.
    expect(elapsedMs).toBeLessThan(250);
  });
});
