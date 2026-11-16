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
  await act(async () => finishSave({ id: 'plant-2' }));
  expect(screen.queryByRole('form', { name: 'Данные растения' })).not.toBeInTheDocument();
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
