/** Copy text to the clipboard; returns an error message on failure. */
export async function copyToClipboard(text: string): Promise<string | null> {
  try {
    await navigator.clipboard.writeText(text);
    return null;
  } catch {
    return "Could not copy — check clipboard permissions.";
  }
}
