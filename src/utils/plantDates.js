export const DAY_IN_MS = 1000 * 60 * 60 * 24;

export function getLocalDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function formatDate(isoString) {
  return new Date(isoString).toLocaleDateString('ru-RU');
}

export function getDaysSinceLastAction(log) {
  if (!Array.isArray(log) || !log.length) return null;
  const last = new Date(log[log.length - 1]);
  const now = new Date();
  // Считаем календарные дни, а не полные 24-часовые отрезки.
  last.setHours(0, 0, 0, 0);
  now.setHours(0, 0, 0, 0);
  return Math.round((now - last) / DAY_IN_MS);
}
