const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (s: string) =>
  esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');

/** Tiny markdown renderer: paragraphs, bold, code, bullet/checklist lists and blockquotes. Escapes everything else. */
export function renderMarkdown(text: string): string {
  const out: string[] = [];
  let list: string[] = [];
  let quote: string[] = [];
  const flushList = () => {
    if (list.length) out.push(`<ul>${list.map((l) => `<li>${l}</li>`).join('')}</ul>`);
    list = [];
  };
  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote>${quote.join('\n')}</blockquote>`);
    quote = [];
  };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const quoted = line.match(/^>\s?(.*)$/);
    if (bullet) {
      flushQuote();
      list.push(inline(bullet[1]));
    } else if (quoted) {
      flushList();
      quote.push(inline(quoted[1]));
    } else {
      flushList();
      flushQuote();
      if (line.trim()) out.push(`<p>${inline(line)}</p>`);
    }
  }
  flushList();
  flushQuote();
  return out.join('');
}

/** Plain text of the Draft section (everything after the "Draft" heading), for copying. */
export function extractDraft(text: string): string {
  const m = text.match(/\*\*Draft\*\*:?\s*([\s\S]*)$/i);
  const body = (m ? m[1] : text).split('\n').map((l) => l.replace(/^>\s?/, '')).join('\n');
  return body.replace(/\*\*(.+?)\*\*/g, '$1').trim();
}
