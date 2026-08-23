import { describe, expect, it, beforeAll } from "vitest";
import { render } from "@testing-library/react";
import type {
  ClaudeStreamMessage,
  ContentBlock,
} from "@/stores/claude-chat-store";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import { ChatMessages } from "@/components/claude-chat/chat-messages";
import { TooltipProvider } from "@/components/ui/tooltip";

// jsdom does not implement element scrolling.
beforeAll(() => {
  Element.prototype.scrollTo = () => {};
});

/**
 * Component-level smoke: mount the real `ChatMessages` against a seeded
 * store and assert what a reader actually sees — bubble count, order, and
 * suppression rules. This is the production-surface complement to the pure
 * fuzz/golden suites.
 */

const txt = (text: string): ContentBlock => ({ type: "text", text });

function seed(messages: ClaudeStreamMessage[]) {
  const tabId = useClaudeChatStore.getState().tabs[0]?.id ?? "t1";
  useClaudeChatStore.setState({
    messages,
    activeTabId: tabId,
    isStreaming: false,
  });
}

function toolRoundTrip(): ClaudeStreamMessage[] {
  return [
    { type: "user", message: { content: [txt("Read the intro chapter")] } },
    {
      type: "assistant",
      message: {
        content: [
          txt("Checking…"),
          { type: "tool_use", id: "t1", name: "Read", input: {} },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: "...intro payload...",
          },
        ],
      },
    },
    { type: "assistant", message: { content: [txt("Intro says hi.")] } },
    { type: "result", result: "Intro says hi." },
  ];
}

describe("component smoke: ChatMessages renders the transcript contract", () => {
  it("tool round-trip shows three bubbles in order, result deduped, payload hidden", () => {
    seed(toolRoundTrip());
    const { container } = render(
      <TooltipProvider>
        <ChatMessages />
      </TooltipProvider>,
    );

    // One wrapper per display entry: user, assistant(tool_use), assistant.
    const bubbles = container.querySelectorAll(".cv-auto-chat");
    expect(bubbles.length).toBe(3);

    const body = container.textContent ?? "";
    const idxUser = body.indexOf("Read the intro chapter");
    const idxChecking = body.indexOf("Checking…");
    const idxAnswer = body.indexOf("Intro says hi.");
    expect(idxUser).toBeGreaterThanOrEqual(0);
    expect(idxChecking).toBeGreaterThan(idxUser);
    expect(idxAnswer).toBeGreaterThan(idxChecking);

    // The duplicated result text must not add a second visible copy…
    expect(body.split("Intro says hi.").length - 1).toBe(1);
    // …and the hidden tool-result payload never reaches the DOM.
    expect(body).not.toContain("...intro payload...");
  });

  it("empty conversation renders zero transcript bubbles", () => {
    seed([]);
    const { container } = render(
      <TooltipProvider>
        <ChatMessages />
      </TooltipProvider>,
    );
    expect(container.querySelectorAll(".cv-auto-chat").length).toBe(0);
  });
});
