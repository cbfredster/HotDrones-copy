// Tiny DOM helpers shared by the UI modules.
export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

export const input = (id: string) => $<HTMLInputElement>(id);

/** Escape text before putting it into innerHTML. */
export function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** True when a keyboard event is aimed at a form control, so shortcuts should stay out of the way. */
export function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  if (t.isContentEditable) return true;
  if (t.tagName === "TEXTAREA" || t.tagName === "SELECT") return true;
  if (t.tagName === "INPUT") {
    const type = (t as HTMLInputElement).type;
    return type !== "range" && type !== "checkbox" && type !== "button";
  }
  return false;
}
