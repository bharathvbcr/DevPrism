import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";

import { MarkdownRenderer } from "@/components/claude-chat/markdown-renderer";
import { useDocumentStore } from "@/stores/document-store";

const PROJECT = "/tmp/wave4-project";

beforeEach(() => {
  useDocumentStore.setState({ projectRoot: PROJECT });
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === "run_shell_command") {
      return { exit_code: 0, stdout: "", stderr: "" };
    }
    return undefined;
  });
});

function renderShell(command: string) {
  render(
    <MarkdownRenderer content={"```bash\n" + command + "\n```"} />,
  );
}

async function openConfirm() {
  await userEvent.click(screen.getByRole("button", { name: "Run command" }));
}

function confirmCommand(): HTMLElement {
  return screen.getByTestId("shell-confirm-command");
}

function shellInvocations(): unknown[][] {
  return vi
    .mocked(invoke)
    .mock.calls.filter((call) => call[0] === "run_shell_command");
}

describe("shell confirm panel", () => {
  it("shows the exact command with whitespace preserved", async () => {
    renderShell("echo hello");
    await openConfirm();
    const shown = confirmCommand();
    expect(shown.textContent).toBe("echo hello");
    expect(shown.className).toContain("whitespace-pre-wrap");
    await userEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(shellInvocations()).toEqual([
      ["run_shell_command", { command: "echo hello", cwd: PROJECT }],
    ]);
  });

  it("requires a second acknowledgement before a multi-line block runs whole", async () => {
    const command = "echo one\necho two";
    renderShell(command);
    await openConfirm();
    expect(confirmCommand().textContent).toBe(command);
    expect(confirmCommand().className).toContain("whitespace-pre-wrap");
    const run = screen.getByRole("button", { name: "Run" });
    expect(run).toBeDisabled();
    fireEvent.click(run);
    expect(shellInvocations()).toEqual([]);
    await userEvent.click(
      screen.getByRole("checkbox", { name: "Run the entire command block" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(shellInvocations()).toEqual([
      ["run_shell_command", { command, cwd: PROJECT }],
    ]);
  });

  it("requires a second acknowledgement for a semicolon or pipe chain and still runs the whole command", async () => {
    const command = "echo a | wc -l; echo b";
    renderShell(command);
    await openConfirm();
    expect(confirmCommand().textContent).toBe(command);
    const run = screen.getByRole("button", { name: "Run" });
    expect(run).toBeDisabled();
    fireEvent.click(run);
    expect(shellInvocations()).toEqual([]);
    await userEvent.click(
      screen.getByRole("checkbox", { name: "Run the entire command block" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(shellInvocations()).toEqual([
      ["run_shell_command", { command, cwd: PROJECT }],
    ]);
  });
});
