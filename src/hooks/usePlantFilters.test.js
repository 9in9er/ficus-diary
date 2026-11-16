import { act, renderHook } from '@testing-library/react';
import usePlantFilters from './usePlantFilters';

const plants = [
  { id: 'fern', name: 'Папоротник', createdAt: '2026-01-01', wateringLog: ['2026-03-03'] },
  { id: 'ficus', name: 'Фикус', createdAt: '2026-02-01', wateringLog: ['2026-03-01'], replanted: true },
  { id: 'aloe', name: 'Алоэ', createdAt: '2026-03-01', pinned: true },
  { id: 'hidden', name: 'Фикус скрытый', hidden: true, replanted: true },
  { id: 'trash-old', name: 'Удалённое', deletedAt: '2026-03-01' },
  { id: 'trash-new', name: 'Удалённое позже', deletedAt: '2026-03-02' },
];

beforeEach(() => localStorage.clear());

test.each([
  ['date', ['aloe', 'ficus', 'fern']],
  ['name', ['aloe', 'fern', 'ficus']],
  ['watering', ['aloe', 'ficus', 'fern']],
])('sorts by %s and keeps pinned plants first', (mode, expected) => {
  const { result } = renderHook(() => usePlantFilters(plants));
  act(() => result.current.setSortMode(mode));
  expect(result.current.sortedPlants.map((plant) => plant.id)).toEqual(expected);
  expect(localStorage.getItem('plantsSortMode')).toBe(mode);
});

test('combines search, hidden and replant filters and sorts trash independently', () => {
  const { result } = renderHook(() => usePlantFilters(plants));
  act(() => {
    result.current.setSearchQuery('ФИКУС');
    result.current.setShowOnlyNeedReplant(true);
  });
  expect(result.current.sortedPlants.map((plant) => plant.id)).toEqual(['ficus']);
  act(() => result.current.setShowOnlyHidden(true));
  expect(result.current.sortedPlants.map((plant) => plant.id)).toEqual(['hidden']);
  expect(result.current.sortedTrashPlants.map((plant) => plant.id)).toEqual(['trash-new', 'trash-old']);
});
