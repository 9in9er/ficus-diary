import { fireEvent, render, screen } from '@testing-library/react';
import PlantCareHistory, { getCareHistoryStats } from './PlantCareHistory';

const log = [
  '2026-10-01T23:30:00+03:00',
  '2026-10-08T01:00:00+03:00',
  '2026-10-18T12:00:00+03:00',
];

const props = {
  plantId: 'plant-1',
  log,
  title: 'Полив',
  historyTitle: 'История полива',
  emptyMessage: 'Ещё не поливали',
  icon: 'droplet.svg',
  iconAlt: 'Полить',
  actionClassName: 'btnWatering',
  listClassName: 'wateringList',
  isTrash: false,
  isPending: false,
  onAction: jest.fn(),
  onDelete: jest.fn(),
};

test('calculates calendar-day intervals from newest to oldest and their average', () => {
  const stats = getCareHistoryStats(log);
  expect(stats.rows.map(({ interval }) => interval)).toEqual([10, 7, null]);
  expect(stats.average).toBe(8.5);
});

test('opens a popover without an inline list and closes it with Escape', () => {
  const { container } = render(<PlantCareHistory {...props} />);
  expect(container.querySelector('ul')).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /Полив/ }));
  expect(screen.getByRole('dialog', { name: 'История полива' })).toBeInTheDocument();
  expect(screen.getByText('8,5 дня')).toBeInTheDocument();

  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('shows no history trigger or disclosure indicator for an empty log', () => {
  render(<PlantCareHistory {...props} log={[]} />);
  expect(screen.getByText('Ещё не поливали')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Полив/ })).not.toBeInTheDocument();
});
