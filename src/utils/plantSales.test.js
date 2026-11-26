import { readPrice, parsePrice, saleFields, salesSummary, sortSales, priceDifference, purchasePriceText, formatDifference } from './plantSales';

test.each([[0, 0], ['0', 0], [850, 850], ['1 200,50 ₽', 1200.5], [null, null], [undefined, null], ['', null], ['около 3000 ₽', null]])('reads legacy price %p as %p', (value, expected) => {
  expect(readPrice(value)).toBe(expected);
});
test.each([-1, '-1', NaN, Infinity, 'abc', true, '1.234', '1e6', '1000000000001'])('rejects invalid sale price %p', (value) => {
  expect(() => parsePrice(value, true)).toThrow('корректную цену');
});
test('distinguishes missing purchase price from free plants', () => {
  expect(purchasePriceText(null)).toBe('не указана');
  expect(purchasePriceText(0)).toBe('0 ₽');
  expect(parsePrice('')).toBeNull();
  expect(() => parsePrice('', true)).toThrow();
  expect(priceDifference({ price: null, salePrice: 100 })).toBeNull();
  expect(priceDifference({ price: 0, salePrice: 100 })).toBe(100);
  expect(formatDifference(-100)).toBe('−100 ₽');
});
test.each(['', '2026-02-30', '2026-13-01', '0000-01-01', '2026-1-1'])('rejects invalid sale date %s', (soldAt) => {
  expect(() => saleFields({ soldAt, salePrice: 0 })).toThrow('дату');
});
test('accepts zero sale price and a past calendar date', () => {
  expect(saleFields({ soldAt: '2020-02-29', salePrice: '0' })).toEqual({ soldAt: '2020-02-29', salePrice: 0 });
});
const sold = [
  { id: 'a', name: 'Алоэ', soldAt: '2026-11-26', salePrice: 1200, price: 850 },
  { id: 'b', name: 'Бегония', soldAt: '2026-11-25', salePrice: 500 },
  { id: 'c', name: 'Фикус', soldAt: '2026-11-24', salePrice: 0, price: 100 },
  { id: 'd', name: 'Драцена', soldAt: '2026-11-23', salePrice: 100, price: 0 },
];
test('summary includes free sales, excludes unknown costs from both sides of the difference and ignores trash/wishlist', () => {
  expect(salesSummary([...sold, { ...sold[0], deletedAt: '2026-11-26' }, { ...sold[0], isWishlisted: true }, { price: 10000 }]))
    .toEqual({ count: 4, revenue: 1800, purchase: 950, difference: 350, incomplete: true });
  expect(salesSummary([])).toEqual({ count: 0, revenue: 0, purchase: 0, difference: 0, incomplete: false });
  expect(salesSummary([{ soldAt: '2026-11-26', price: 0.1, salePrice: 0.3 }]).difference).toBe(0.2);
});
test.each([['recent', ['a', 'b', 'c', 'd']], ['oldest', ['d', 'c', 'b', 'a']], ['priceAsc', ['c', 'd', 'b', 'a']], ['priceDesc', ['a', 'b', 'd', 'c']], ['name', ['a', 'b', 'd', 'c']]])('sorts sales by %s', (mode, ids) => {
  expect(sortSales(sold, '', mode).map((plant) => plant.id)).toEqual(ids);
});
test('sales search is case insensitive and keeps hidden flags from excluding archived plants', () => {
  expect(sortSales([...sold, { ...sold[0], deletedAt: '2026-11-26' }], ' АЛОЭ ', 'recent').map((plant) => plant.id)).toEqual(['a']);
});
