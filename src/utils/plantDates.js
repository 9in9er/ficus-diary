export const DAY_IN_MS = 1000 * 60 * 60 * 24;
export const TRASH_RETENTION_DAYS = 30;

export function formatDate(isoString) {
  return new Date(isoString).toLocaleDateString('ru-RU');
}

export function getDaysUntilDelete(deletedAt) {
  if (!deletedAt) return null;
  const daysInTrash = Math.floor((Date.now() - new Date(deletedAt)) / DAY_IN_MS);
  return Math.max(TRASH_RETENTION_DAYS - daysInTrash, 0);
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
