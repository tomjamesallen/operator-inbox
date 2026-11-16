// One clipboard path for the page.
// `navigator.clipboard` needs a secure context — 127.0.0.1 is one, but a page
// reached some other way may not be — so fall back to a hidden textarea rather
// than failing silently. Resolves to whether the text reached the clipboard.

// How long a copy control shows its outcome (✓ / ✗ / "Copied") before it
// reverts. ONE number for every copy control on the page.
export const COPY_FEEDBACK_MS = 1_200;

export const copyText = async (text: string): Promise<boolean> => {
  try {
    if (navigator.clipboard?.writeText !== undefined) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the textarea
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const copied = document.execCommand('copy');
    document.body.removeChild(ta);
    return copied;
  } catch {
    return false;
  }
};
