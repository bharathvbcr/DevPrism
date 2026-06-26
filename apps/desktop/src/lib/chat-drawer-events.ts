export const CHAT_DRAWER_TOGGLE_EVENT = "devprism:toggle-chat-drawer";
export const CHAT_DRAWER_OPEN_EVENT = "devprism:open-chat-drawer";
export const CHAT_DRAWER_FOCUS_COMPOSER_EVENT = "devprism:focus-chat-composer";

export type ChatDrawerOpenDetail = {
  focusComposer?: boolean;
};

export function toggleChatDrawer() {
  window.dispatchEvent(new CustomEvent(CHAT_DRAWER_TOGGLE_EVENT));
}

export function openChatDrawer(options?: ChatDrawerOpenDetail) {
  window.dispatchEvent(
    new CustomEvent<ChatDrawerOpenDetail>(CHAT_DRAWER_OPEN_EVENT, {
      detail: options ?? {},
    }),
  );
}

export function focusChatComposer() {
  window.dispatchEvent(new CustomEvent(CHAT_DRAWER_FOCUS_COMPOSER_EVENT));
}

export function chatDrawerShortcutLabel(
  key: string,
  options?: { shift?: boolean },
): string {
  const isMac = navigator.platform.startsWith("Mac");
  const mod = isMac ? "⌘" : "Ctrl";
  const shift = options?.shift ? (isMac ? "⇧" : "Shift+") : "";
  return `${mod}${shift}${key}`;
}
