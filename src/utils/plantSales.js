// Older wishlist documents may contain a formatted price instead of a number.
export function readPrice(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = typeof value === 'string' ? value.trim().replace(/\s/g, '').replace(/₽$/, '').replace(',', '.') : value;
  if (typeof text !== 'number' && (typeof text !== 'string' || !/^\d+(\.\d{1,2})?$/.test(text))) return null;
  const number = Number(text);
  return Number.isFinite(number) && number >= 0 && number <= 1e12 ? number : null;
}

export function parsePrice(value, required = false) {
  if (value === undefined || value === null || String(value).trim() === '') {
    if (!required) return null;
  } else {
    const price = readPrice(value);
    if (price !== null) return price;
  }
  throw new Error('Укажите корректную цену от 0 до 1 000 000 000 000 ₽, не более двух знаков после запятой.');
}

export function isSaleDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && value.slice(0, 4) !== '0000' && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
}

export function saleFields(draft) {
  if (!isSaleDate(draft.soldAt)) throw new Error('Укажите корректную дату продажи.');
  return { soldAt: draft.soldAt, salePrice: parsePrice(draft.salePrice, true) };
}

export const isSold = (plant) => !!plant.soldAt;
export const formatMoney = (value) => `${value.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;
export const purchasePriceText = (value) => readPrice(value) === null ? 'не указана' : formatMoney(readPrice(value));
export const priceDifference = (plant) => readPrice(plant.price) === null || readPrice(plant.salePrice) === null
  ? null : Math.round((readPrice(plant.salePrice) - readPrice(plant.price)) * 100) / 100;
export const formatDifference = (value) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${formatMoney(Math.abs(value))}`;

export function salesSummary(plants) {
  const sold = plants.filter((plant) => isSold(plant) && !plant.deletedAt && !plant.isWishlisted);
  const known = sold.filter((plant) => readPrice(plant.price) !== null);
  const sum = (items, field) => items.reduce((total, plant) => total + Math.round((readPrice(plant[field]) ?? 0) * 100), 0) / 100;
  const purchase = sum(known, 'price');
  return { count: sold.length, revenue: sum(sold, 'salePrice'), purchase,
    difference: Math.round((sum(known, 'salePrice') - purchase) * 100) / 100,
    incomplete: known.length !== sold.length };
}

export function sortSales(plants, search, mode) {
  return plants.filter((plant) => isSold(plant) && !plant.deletedAt && !plant.isWishlisted
    && (plant.name || '').toLocaleLowerCase('ru').includes(search.trim().toLocaleLowerCase('ru')))
    .sort((a, b) => {
      if (mode === 'name') return (a.name || '').localeCompare(b.name || '', 'ru');
      if (mode === 'priceAsc' || mode === 'priceDesc') return ((readPrice(a.salePrice) ?? 0) - (readPrice(b.salePrice) ?? 0)) * (mode === 'priceAsc' ? 1 : -1);
      return (a.soldAt || '').localeCompare(b.soldAt || '') * (mode === 'oldest' ? 1 : -1);
    });
}
