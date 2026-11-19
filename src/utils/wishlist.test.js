import { getWishlistDetails, normalizeWishlistLink } from './wishlist';
import { getLocalDate } from './plantDates';

test.each(['javascript:alert(1)', 'data:text/html,hello', 'file:///tmp/plant', 'https://user:password@example.com', 'not a link'])('rejects unsafe or malformed link %s', (link) => {
  expect(normalizeWishlistLink(link)).toBeNull();
  expect(() => getWishlistDetails({ links: link })).toThrow('Укажите корректные ссылки');
});

test('normalizes pasted domains, trims details, removes blank lines and duplicate links', () => {
  expect(getWishlistDetails({ description: ' Листья ', price: ' 500 ₽ ', links: 'example.com\n\nhttps://example.com/' })).toEqual({
    description: 'Листья', price: '500 ₽', links: ['https://example.com/'],
  });
});

test('uses the local calendar date near midnight rather than the UTC date', () => {
  const date = new Date(2026, 10, 19, 0, 5);
  expect(getLocalDate(date)).toBe('2026-11-19');
});
