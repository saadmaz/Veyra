export interface RenderedEmail {
  subject: string;
  html: string;
  /** Plain-text alternative: always sent alongside HTML for accessibility and deliverability. */
  text: string;
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes user-controlled values before they are placed in HTML. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/** Minimal, email-client-safe layout (inline styles, table-free single column). */
export function layout(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:24px;background:#f7f7f5;font-family:Arial,Helvetica,sans-serif;color:#15171a;">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e3e4e0;border-radius:10px;padding:32px;">
<p style="margin:0 0 24px;font-size:12px;letter-spacing:0.2em;font-weight:bold;color:#1f4e46;">VEYRA</p>
${bodyHtml}
</div>
</body>
</html>`;
}
