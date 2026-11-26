import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { deleteDoc, doc, onSnapshot, updateDoc } from 'firebase/firestore';
import PlantsPage from './PlantsPage';
import usePlantActions from '../hooks/usePlantActions';
import { photoRequest } from '../services/plantPhotos';

jest.mock('../services/plantPhotos', () => ({ photoRequest: jest.fn(), savePlantPhoto: jest.fn() }));

jest.mock('../firebase', () => ({ db: {} }));
jest.mock('../hooks/useAuth', () => {
  const user = { uid: 'user-1' };
  return { useAuth: () => ({ user }) };
});
jest.mock('firebase/firestore', () => ({
  collection: jest.fn(), query: jest.fn(), where: jest.fn(), doc: jest.fn(),
  onSnapshot: jest.fn(), addDoc: jest.fn(), updateDoc: jest.fn(), deleteDoc: jest.fn(),
}));
jest.mock('../i/icons/grid-3-columns.svg', () => ({ ReactComponent: () => <svg /> }));
jest.mock('../i/icons/grid-4-columns.svg', () => ({ ReactComponent: () => <svg /> }));
jest.mock('../i/icons/grid-8-columns.svg', () => ({ ReactComponent: () => <svg /> }));
jest.mock('../i/icons/grid-1-column.svg', () => ({ ReactComponent: () => <svg /> }));
jest.mock('../i/icons/grid-2-columns.svg', () => ({ ReactComponent: () => <svg /> }));

const plant = {
  id: 'plant-1', name: 'Фикус', hidden: false,
  notes: [{ id: 'note-1', text: 'Существующая заметка', createdAt: new Date().toISOString() }],
  wateringLog: [new Date().toISOString()],
  fertilizingLog: [new Date().toISOString()],
};
let snapshotListener;
let plants;
const originalResizeObserver = window.ResizeObserver;

beforeAll(() => {
  window.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
});

afterAll(() => {
  window.ResizeObserver = originalResizeObserver;
});

function snapshot(items) {
  return { docs: items.map(({ id, ...data }) => ({ id, data: () => data })) };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

function renderPage() {
  render(<MemoryRouter><PlantsPage /></MemoryRouter>);
}

beforeEach(() => {
  jest.resetAllMocks();
  localStorage.clear();
  plants = [plant];
  doc.mockImplementation((db, collection, id) => ({ id }));
  onSnapshot.mockImplementation((query, onSuccess) => {
    snapshotListener = onSuccess;
    onSuccess(snapshot(plants));
    return jest.fn();
  });
  updateDoc.mockResolvedValue();
  deleteDoc.mockResolvedValue();
  photoRequest.mockResolvedValue({ deleted: true });
});

test.each([
  ['watering', 'iconEmojiDroplet', updateDoc, 'Не удалось сохранить полив.', null],
  ['fertilizing', 'iconEmojiTestTube', updateDoc, 'Не удалось сохранить удобрение.', null],
  ['pinning', 'iconEmojiPushpin', updateDoc, 'Не удалось изменить закрепление.', 'menu'],
  ['replanting', 'iconEmojiShovel', updateDoc, 'Не удалось изменить отметку пересадки.', 'menu'],
  ['hiding', 'iconEmojiEye iconEmojiEyeOff', updateDoc, 'Не удалось изменить видимость растения.', 'menu'],
  ['moving to trash', 'iconEmojiWastebasket', updateDoc, 'Не удалось переместить растение в корзину.', 'menu'],
  ['restoring', 'Восстановить растение', updateDoc, 'Не удалось восстановить растение.', 'trash'],
  ['permanent deletion', 'Удалить растение навсегда', photoRequest, 'Не удалось удалить растение навсегда.', 'trash'],
  ['note deletion', '✖', updateDoc, 'Не удалось удалить заметку.', null],
  ['watering entry deletion', /^Удалить запись: история полива,/, updateDoc, 'Не удалось удалить запись полива.', 'Полив'],
  ['fertilizing entry deletion', /^Удалить запись: история удобрения,/, updateDoc, 'Не удалось удалить запись удобрения.', 'Удобрение'],
])('blocks repeated %s, reports failure and allows retrying', async (name, buttonName, request, message, prepare) => {
  const pending = deferred();
  request.mockReturnValueOnce(pending.promise);
  if (prepare === 'trash') plants = [{ ...plant, deletedAt: new Date().toISOString() }];
  renderPage();
  if (prepare === 'trash') {
    fireEvent.click(screen.getByRole('button', { name: 'Архив' }));
    fireEvent.click(screen.getByRole('button', { name: 'Корзина (1)' }));
  }
  const card = screen.getByRole('listitem', { name: 'Фикус' });
  if (prepare === 'menu') fireEvent.click(within(card).getByRole('button', { name: 'menu' }));
  else if (prepare && prepare !== 'trash') fireEvent.click(within(card).getByText(prepare));
  const trigger = prepare === 'Полив' || prepare === 'Удобрение'
    ? screen.getByRole('button', { name: buttonName })
    : within(card).getByRole('button', { name: buttonName });

  fireEvent.click(trigger);
  expect(trigger).toBeDisabled();
  expect(card).toHaveAttribute('aria-busy', 'true');
  expect(within(card).getByRole('status')).toHaveTextContent('Сохраняем изменения');
  const menuToggle = within(card).queryByRole('button', { name: /^(menu|close)$/ });
  const controls = [
    ...within(card).getAllByRole('button', { hidden: true }).filter((control) => control !== menuToggle),
    ...within(card).queryAllByRole('textbox', { name: 'Новая заметка' }),
  ];
  controls.forEach((control) => expect(control).toBeDisabled());
  fireEvent.click(trigger);
  expect(request).toHaveBeenCalledTimes(1);

  await act(async () => pending.reject(new Error('permission-denied')));
  expect(await screen.findByRole('alert')).toHaveTextContent(`Фикус: ${message}`);
  expect(trigger).toBeEnabled();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();

  fireEvent.click(trigger);
  await waitFor(() => expect(card).toHaveAttribute('aria-busy', 'false'));
  expect(request).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('keeps the request lock across filters and reports failure even when the card disappears', async () => {
  const pending = deferred();
  updateDoc.mockReturnValueOnce(pending.promise);
  renderPage();
  fireEvent.click(screen.getByRole('button', { name: 'menu' }));
  fireEvent.click(screen.getByRole('button', { name: 'iconEmojiEye iconEmojiEyeOff' }));

  // Firestore can emit a local change before the server accepts or rejects it.
  act(() => snapshotListener(snapshot([{ ...plant, hidden: true }])));
  expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Скрытые' }));
  expect(screen.getByRole('button', { name: 'iconEmojiDroplet' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Все растения Все' }));
  expect(screen.queryByRole('listitem')).not.toBeInTheDocument();

  await act(async () => pending.reject(new Error('permission-denied')));
  expect(await screen.findByRole('alert')).toHaveTextContent('Фикус: Не удалось изменить видимость растения.');
  act(() => snapshotListener(snapshot([plant])));
  expect(screen.getByRole('button', { name: 'iconEmojiDroplet' })).toBeEnabled();
});

test('keeps other cards usable while one plant is saving', async () => {
  const pending = deferred();
  plants = [plant, { ...plant, id: 'plant-2', name: 'Монстера' }];
  updateDoc.mockReturnValueOnce(pending.promise);
  renderPage();
  const cards = ['Фикус', 'Монстера'].map((name) => screen.getByRole('listitem', { name }));
  fireEvent.click(within(cards[0]).getByRole('button', { name: 'iconEmojiDroplet' }));
  const otherButton = within(cards[1]).getByRole('button', { name: 'iconEmojiDroplet' });
  expect(otherButton).toBeEnabled();
  fireEvent.click(otherButton);
  await waitFor(() => expect(cards[1]).toHaveAttribute('aria-busy', 'false'));
  expect(cards[0]).toHaveAttribute('aria-busy', 'true');
  expect(updateDoc).toHaveBeenCalledTimes(2);
  await act(async () => pending.resolve());
});

test('blocks a second action on the same plant before React renders disabled controls', async () => {
  const pending = deferred();
  const action = jest.fn(() => pending.promise);
  const { result } = renderHook(() => usePlantActions());
  let first;
  let second;
  act(() => {
    first = result.current.runAction(plant, action, 'Ошибка');
    second = result.current.runAction(plant, action, 'Ошибка');
  });
  expect(action).toHaveBeenCalledTimes(1);
  expect(await second).toBe(false);
  await act(async () => pending.resolve());
  expect(await first).toBe(true);
});
