import { describe, it, expect, beforeEach } from "vitest";
import { useClaudeChatStore } from "@/stores/claude-chat-store";

// The "Tailor with AI" action seeds a prompt into the composer via the store;
// the drawer auto-opens on it and the composer consumes it exactly once.
describe("claude-chat-store: composer seed channel", () => {
  beforeEach(() => {
    useClaudeChatStore.setState({ pendingComposerInput: null });
  });

  it("seeds a prompt and consumes it exactly once", () => {
    expect(useClaudeChatStore.getState().pendingComposerInput).toBeNull();

    useClaudeChatStore.getState().seedComposerInput("Tailor this resume");
    expect(useClaudeChatStore.getState().pendingComposerInput).toBe(
      "Tailor this resume",
    );

    const consumed = useClaudeChatStore
      .getState()
      .consumePendingComposerInput();
    expect(consumed).toBe("Tailor this resume");
    // Cleared so the consuming effect doesn't re-fire on the next render.
    expect(useClaudeChatStore.getState().pendingComposerInput).toBeNull();
  });

  it("returns null when nothing is seeded", () => {
    expect(
      useClaudeChatStore.getState().consumePendingComposerInput(),
    ).toBeNull();
  });
});
