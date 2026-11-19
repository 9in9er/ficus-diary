export function normalizeWishlistLink(value) {
  const text = value.trim();
  if (!text) return null;
  try {
    // Accept pasted domains, but never turn executable or local URLs into links.
    const candidate = /^[a-z][a-z\d+.-]*:/i.test(text) ? text : `https://${text}`;
    const url = new URL(candidate);
    if (!['https:', 'http:'].includes(url.protocol) || !url.hostname.includes('.') || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function getWishlistDetails(draft) {
  const entries = (draft.links || '').split('\n').map((line) => line.trim()).filter(Boolean);
  const links = entries.map(normalizeWishlistLink);
  if (links.some((link) => !link)) throw new Error('Укажите корректные ссылки на сайты, каждую с новой строки.');
  return { description: (draft.description || '').trim(), price: (draft.price || '').trim(), links: [...new Set(links)] };
}
