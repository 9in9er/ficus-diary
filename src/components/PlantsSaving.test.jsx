import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { addDoc, onSnapshot, updateDoc } from 'firebase/firestore';
import PlantsPage from './PlantsPage';

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

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
  onSnapshot.mockImplementation((query, onSuccess) => {
    onSuccess({ docs: [{ id: 'plant-1', data: () => ({ name: 'Фикус', notes: [] }) }] });
    return jest.fn();
  });
  addDoc.mockResolvedValue({ id: 'plant-2' });
  updateDoc.mockResolvedValue();
});

function renderPage() {
  render(<MemoryRouter><PlantsPage /></MemoryRouter>);
}

function openAddForm() {
  fireEvent.click(screen.getByRole('button', { name: 'Добавить растение' }));
  fireEvent.change(screen.getByLabelText('Название растения'), { target: { value: 'Монстера' } });
}

test('keeps the add form open and prevents repeated saves while Firestore is pending', async () => {
  let finishSave;
  addDoc.mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve; }));
  renderPage();
  openAddForm();
  const form = screen.getByRole('form', { name: 'Данные растения' });
  fireEvent.submit(form);
  expect(screen.getByRole('button', { name: 'Сохраняем…' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Отмена' })).toBeDisabled();
  expect(screen.getByLabelText('Название растения')).toHaveValue('Монстера');
  fireEvent.submit(form);
  expect(addDoc).toHaveBeenCalledTimes(1);
  fireEvent(screen.getByRole('dialog', { name: 'Добавить растение' }), new Event('cancel', { cancelable: true }));
  expect(screen.getByRole('dialog', { name: 'Добавить растение' })).toBeInTheDocument();
  await act(async () => finishSave({ id: 'plant-2' }));
  expect(screen.queryByRole('form', { name: 'Данные растения' })).not.toBeInTheDocument();
  expect(addDoc.mock.calls[0][1]).not.toHaveProperty('photo');
});

test('preserves the add form after a failed save and allows retrying', async () => {
  addDoc.mockRejectedValueOnce(new Error('offline'));
  renderPage();
  openAddForm();
  fireEvent.submit(screen.getByRole('form', { name: 'Данные растения' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось сохранить растение');
  expect(screen.getByLabelText('Название растения')).toHaveValue('Монстера');
  fireEvent.submit(screen.getByRole('form', { name: 'Данные растения' }));
  await waitFor(() => expect(screen.queryByRole('form', { name: 'Данные растения' })).not.toBeInTheDocument());
  expect(addDoc).toHaveBeenCalledTimes(2);
});

test('clears a note only after a successful save', async () => {
  let finishSave;
  updateDoc.mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve; }));
  renderPage();
  const input = screen.getByRole('textbox', { name: 'Новая заметка' });
  fireEvent.change(input, { target: { value: 'Новый лист' } });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить заметку' }));
  expect(input).toHaveValue('Новый лист');
  expect(input).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Сохранить заметку' })).toBeDisabled();
  await act(async () => finishSave());
  expect(input).toHaveValue('');
  expect(input).toBeEnabled();
});

test('preserves a note after a failed save and allows retrying', async () => {
  updateDoc.mockRejectedValueOnce(new Error('offline'));
  renderPage();
  const input = screen.getByRole('textbox', { name: 'Новая заметка' });
  fireEvent.change(input, { target: { value: 'Новый лист' } });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить заметку' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось сохранить заметку');
  expect(input).toHaveValue('Новый лист');
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить заметку' }));
  await waitFor(() => expect(input).toHaveValue(''));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(updateDoc).toHaveBeenCalledTimes(2);
});

test('preserves edits after a failed save and allows retrying', async () => {
  updateDoc.mockRejectedValueOnce(new Error('offline'));
  renderPage();
  fireEvent.click(screen.getByRole('button', { name: 'menu' }));
  fireEvent.click(screen.getByRole('button', { name: 'iconEmojiPencil' }));
  fireEvent.change(screen.getByLabelText('Название растения'), { target: { value: 'Фикус эластика' } });
  fireEvent.submit(screen.getByRole('form', { name: 'Данные растения' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось сохранить изменения');
  expect(screen.getByLabelText('Название растения')).toHaveValue('Фикус эластика');
  fireEvent.submit(screen.getByRole('form', { name: 'Данные растения' }));
  await waitFor(() => expect(screen.queryByRole('form', { name: 'Данные растения' })).not.toBeInTheDocument());
  expect(updateDoc).toHaveBeenCalledTimes(2);
  for (const [, fields] of updateDoc.mock.calls) {
    expect(fields).not.toHaveProperty('photo');
    expect(fields).not.toHaveProperty('photoKey');
  }
});

test('ends loading and reports a Firestore subscription error', () => {
  onSnapshot.mockImplementationOnce((query, onSuccess, onError) => {
    onError(new Error('permission-denied'));
    return jest.fn();
  });
  renderPage();
  expect(screen.getByRole('alert')).toHaveTextContent('Не удалось загрузить растения');
  expect(screen.queryByText('Загружаем ваши растения…')).not.toBeInTheDocument();
});

test('focuses the add form, closes on Escape and restores the trigger focus', () => {
  renderPage();
  const trigger = screen.getByRole('button', { name: 'Добавить растение' });
  trigger.focus();
  fireEvent.click(trigger);
  expect(screen.getByLabelText('Название растения')).toHaveFocus();
  fireEvent(screen.getByRole('dialog', { name: 'Добавить растение' }), new Event('cancel', { cancelable: true }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

test('keeps the add dialog and its draft when file selection is cancelled', () => {
  renderPage();
  openAddForm();
  fireEvent(screen.getByLabelText('Фотография растения'), new Event('cancel', { bubbles: true }));
  expect(screen.getByRole('dialog', { name: 'Добавить растение' })).toBeInTheDocument();
  expect(screen.getByLabelText('Название растения')).toHaveValue('Монстера');
  expect(addDoc).not.toHaveBeenCalled();
});

test('explains an empty search and clears the message when search is reset', () => {
  renderPage();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Монстера' } });
  expect(screen.getByRole('status')).toHaveTextContent('По вашему запросу растения не найдены');
  expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Очистить поиск' }));
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Фикус' })).toBeInTheDocument();
});

test('shows the first-plant message only once for an empty collection', () => {
  onSnapshot.mockImplementationOnce((query, onSuccess) => {
    onSuccess({ docs: [] });
    return jest.fn();
  });
  renderPage();
  expect(screen.getAllByText('Добавьте первое растение!')).toHaveLength(1);
  expect(screen.getByRole('status')).toHaveTextContent('Добавьте первое растение!');
});

test('shows care history and all notes in trash without exposing edit controls', () => {
  const daysAgo = (days) => new Date(Date.now() - days * 86400000).toISOString();
  onSnapshot.mockImplementationOnce((query, onSuccess) => {
    onSuccess({ docs: [{ id: 'deleted-plant', data: () => ({
      name: 'Удалённый фикус',
      deletedAt: daysAgo(1),
      wateringLog: [daysAgo(3)],
      fertilizingLog: [daysAgo(7)],
      notes: Array.from({ length: 5 }, (_, index) => ({ id: String(index), text: `Заметка ${index + 1}`, createdAt: daysAgo(index + 1) })),
    }) }] });
    return jest.fn();
  });
  renderPage();
  fireEvent.click(screen.getByRole('button', { name: 'Архив' }));
  fireEvent.click(screen.getByRole('button', { name: 'Корзина (1)' }));
  expect(screen.getByText('3 дн. назад')).toBeVisible();
  expect(screen.getByText('7 дн. назад')).toBeVisible();
  expect(screen.queryByText('ещё не поливали')).not.toBeInTheDocument();
  expect(screen.queryByText('ещё не удобряли')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Удалить запись:/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '✖' })).not.toBeInTheDocument();
  expect(screen.queryByRole('textbox', { name: 'Новая заметка' })).not.toBeInTheDocument();
  expect(screen.getByText('Заметка 5')).not.toBeVisible();
  fireEvent.click(screen.getByText('Показать все заметки (2)'));
  expect(screen.getByText('Заметка 4')).toBeVisible();
  expect(screen.getByText('Заметка 5')).toBeVisible();
});
