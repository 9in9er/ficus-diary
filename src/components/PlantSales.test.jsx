import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { doc, onSnapshot, updateDoc } from 'firebase/firestore';
import PlantsPage from './PlantsPage';
import { getLocalDate } from '../utils/plantDates';

jest.mock('../firebase', () => ({ db: {} }));
jest.mock('../services/plantPhotos', () => ({ photoRequest: jest.fn(), savePlantPhoto: jest.fn() }));
jest.mock('../hooks/useAuth', () => {
  const user = { uid: 'owner' };
  return { useAuth: () => ({ user }) };
});
jest.mock('firebase/firestore', () => ({
  collection: jest.fn(), query: jest.fn(), where: jest.fn(), doc: jest.fn(),
  onSnapshot: jest.fn(), addDoc: jest.fn(), updateDoc: jest.fn(),
}));
jest.mock('../i/icons/grid-3-columns.svg', () => ({ ReactComponent: () => <svg /> }));
jest.mock('../i/icons/grid-4-columns.svg', () => ({ ReactComponent: () => <svg /> }));
jest.mock('../i/icons/grid-8-columns.svg', () => ({ ReactComponent: () => <svg /> }));
jest.mock('../i/icons/grid-1-column.svg', () => ({ ReactComponent: () => <svg /> }));
jest.mock('../i/icons/grid-2-columns.svg', () => ({ ReactComponent: () => <svg /> }));

const plant = { id: 'ficus', name: 'Фикус', acquiredAt: '2026-01-01', price: 850,
  photo: 'https://example.com/ficus.jpg',
  wateringLog: ['2026-11-20'], fertilizingLog: ['2026-11-10'],
  notes: [{ id: 'note', text: 'Старый лист', createdAt: '2026-11-01' }] };
let records;
let emit;
const snapshot = () => ({ docs: records.map(({ id, ...data }) => ({ id, data: () => data })) });
const renderPage = () => render(<MemoryRouter><PlantsPage /></MemoryRouter>);
const openArchive = () => fireEvent.click(screen.getByRole('button', { name: 'Архив' }));
const menu = () => fireEvent.click(screen.getByRole('button', { name: 'menu' }));
const originalResizeObserver = window.ResizeObserver;
beforeAll(() => { window.ResizeObserver = class { observe() {} disconnect() {} }; });
afterAll(() => { window.ResizeObserver = originalResizeObserver; });
beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
  records = [{ ...plant }];
  doc.mockImplementation((db, collection, id) => ({ id }));
  onSnapshot.mockImplementation((query, listener) => { emit = () => listener(snapshot()); emit(); return jest.fn(); });
  updateDoc.mockImplementation(async ({ id }, patch) => {
    records = records.map((record) => record.id === id ? { ...record, ...patch } : record);
    emit();
  });
});

test.each([[850, '850 ₽'], [0, '0 ₽'], [undefined, 'не указана']])('shows purchase price %p below acquisition date', (price, text) => {
  records[0].price = price;
  renderPage();
  const label = screen.getByText(`Цена покупки: ${text}`);
  expect(label.previousElementSibling).toHaveClass('dateOfAppearance');
});

test.each(['1200', '0'])('sells for %s, keeps ID, photo and history, and exposes read-only archived history', async (salePrice) => {
  renderPage();
  menu();
  fireEvent.click(screen.getByRole('button', { name: 'Продано' }));
  const dialog = screen.getByRole('dialog', { name: 'Продажа растения' });
  expect(within(dialog).getByLabelText('Дата продажи')).toHaveValue(getLocalDate());
  fireEvent.change(within(dialog).getByLabelText('Цена продажи, ₽'), { target: { value: salePrice } });
  fireEvent.change(within(dialog).getByLabelText('Дата продажи'), { target: { value: '2026-10-01' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Отметить проданным' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(updateDoc).toHaveBeenCalledWith({ id: plant.id }, { soldAt: '2026-10-01', salePrice: Number(salePrice), hidden: false, pinned: false });
  expect(records[0]).toMatchObject(plant);
  expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
  openArchive();
  expect(screen.getByRole('button', { name: 'Проданные (1)' })).toHaveAttribute('aria-pressed', 'true');
  const card = within(screen.getByRole('listitem', { name: 'Фикус' }));
  expect(card.queryByRole('textbox', { name: 'Новая заметка' })).not.toBeInTheDocument();
  expect(card.queryByRole('button', { name: 'iconEmojiDroplet' })).not.toBeInTheDocument();
  expect(card.getByRole('button', { name: 'Увеличить фото: Фикус' })).toBeEnabled();
  const history = card.getByText('История ухода и заметки').closest('details');
  fireEvent.click(within(history).getByText('История ухода и заметки'));
  expect(history).toHaveTextContent('20.11.2026');
  expect(history).toHaveTextContent('10.11.2026');
  expect(history).toHaveTextContent('Старый лист');
  expect(within(history).queryByRole('button')).not.toBeInTheDocument();
});

test('keeps the sale dialog open on error, prevents double submission and allows retry', async () => {
  let reject;
  updateDoc.mockImplementationOnce(() => new Promise((resolve, onReject) => { reject = onReject; }));
  renderPage(); menu(); fireEvent.click(screen.getByRole('button', { name: 'Продано' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('Цена продажи, ₽'), { target: { value: '0' } });
  const submit = within(dialog).getByRole('button', { name: 'Отметить проданным' });
  fireEvent.click(submit); fireEvent.click(submit);
  expect(updateDoc).toHaveBeenCalledTimes(1);
  expect(submit).toBeDisabled();
  await act(async () => reject(new Error('offline')));
  expect(within(dialog).getByRole('alert')).toHaveTextContent('Не удалось сохранить продажу');
  expect(submit).toBeEnabled();
  fireEvent.click(submit);
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

test('shows an access failure inside the sale dialog and allows retry after rules are corrected', async () => {
  updateDoc.mockRejectedValueOnce(Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' }));
  renderPage(); menu(); fireEvent.click(screen.getByRole('button', { name: 'Продано' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('Цена продажи, ₽'), { target: { value: '600' } });
  fireEvent.change(within(dialog).getByLabelText('Дата продажи'), { target: { value: '2026-11-23' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Отметить проданным' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('permission-denied');
  expect(within(dialog).getByLabelText('Цена продажи, ₽')).toHaveValue(600);
  expect(within(dialog).getByLabelText('Дата продажи')).toHaveValue('2026-11-23');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Отметить проданным' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

test('validates missing/negative price and invalid sale dates even on programmatic submit', () => {
  renderPage(); menu(); fireEvent.click(screen.getByRole('button', { name: 'Продано' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.submit(dialog.querySelector('form'));
  expect(within(dialog).getByRole('alert')).toHaveTextContent('корректную цену');
  fireEvent.change(within(dialog).getByLabelText('Цена продажи, ₽'), { target: { value: '-1' } });
  fireEvent.submit(dialog.querySelector('form'));
  expect(updateDoc).not.toHaveBeenCalled();
  fireEvent.change(within(dialog).getByLabelText('Цена продажи, ₽'), { target: { value: '0' } });
  fireEvent.change(within(dialog).getByLabelText('Дата продажи'), { target: { value: '' } });
  fireEvent.submit(dialog.querySelector('form'));
  expect(within(dialog).getByRole('alert')).toHaveTextContent('дату');
  expect(updateDoc).not.toHaveBeenCalled();
});

test('edits sale and purchase data, moves to trash and restores to sold with the same data', async () => {
  records[0] = { ...plant, soldAt: '2026-11-25', salePrice: 1200 };
  renderPage(); openArchive(); menu();
  fireEvent.click(screen.getByRole('button', { name: 'Редактировать' }));
  fireEvent.change(screen.getByLabelText('Цена покупки, ₽'), { target: { value: '0' } });
  fireEvent.change(screen.getByLabelText('Цена продажи, ₽'), { target: { value: '0' } });
  fireEvent.change(screen.getByLabelText('Дата продажи'), { target: { value: '2026-11-01' } });
  // Keep this test on the metadata path; the URL photo path is covered in server tests.
  fireEvent.click(screen.getByRole('button', { name: 'Загрузить файл' }));
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
  await waitFor(() => expect(screen.queryByRole('form')).not.toBeInTheDocument());
  expect(records[0]).toMatchObject({ price: 0, salePrice: 0, soldAt: '2026-11-01', photo: plant.photo, notes: plant.notes });
  menu(); fireEvent.click(screen.getByRole('button', { name: 'Удалить' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Проданные (0)' })).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: 'Корзина (1)' }));
  fireEvent.click(screen.getByRole('button', { name: 'Восстановить растение' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Проданные (1)' })).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: 'Проданные (1)' }));
  expect(records[0]).toMatchObject({ deletedAt: null, price: 0, salePrice: 0, soldAt: '2026-11-01', photo: plant.photo, notes: plant.notes });
  expect(screen.getByRole('region', { name: 'Сводка продаж' })).toHaveTextContent('Продано растений1');
});

test('confirms cancellation, clears sale and returns to collection with history', async () => {
  records[0] = { ...plant, soldAt: '2026-11-25', salePrice: 1200 };
  renderPage(); openArchive(); menu();
  expect(screen.queryByRole('button', { name: 'Продано' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Отменить продажу' }));
  expect(updateDoc).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Оставить продажу' }));
  expect(updateDoc).not.toHaveBeenCalled();
  menu(); fireEvent.click(screen.getByRole('button', { name: 'Отменить продажу' }));
  fireEvent.click(screen.getByRole('button', { name: 'Вернуть в коллекцию' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Проданные (0)' })).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: 'Все растения Все' }));
  expect(screen.getByRole('listitem', { name: 'Фикус' })).toHaveTextContent('Старый лист');
  expect(records[0]).toMatchObject({ ...plant, soldAt: null, salePrice: null, pinned: false, hidden: false });
});

test('summary uses all sold plants regardless of search and sorting', () => {
  records = [{ ...plant, soldAt: '2026-11-25', salePrice: 1200 }, { id: 'aloe', name: 'Алоэ', soldAt: '2026-11-26', salePrice: 0 }];
  renderPage(); openArchive();
  expect(screen.getAllByRole('listitem', { name: /Алоэ|Фикус/ }).map((item) => item.getAttribute('aria-label'))).toEqual(['Алоэ', 'Фикус']);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'oldest' } });
  expect(screen.getAllByRole('listitem', { name: /Алоэ|Фикус/ }).map((item) => item.getAttribute('aria-label'))).toEqual(['Фикус', 'Алоэ']);
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'ФИКУС' } });
  expect(screen.getAllByRole('listitem', { name: /Алоэ|Фикус/ })).toHaveLength(1);
  expect(screen.getByRole('region', { name: 'Сводка продаж' })).toHaveTextContent('Продано растений2');
  expect(screen.getByRole('region', { name: 'Сводка продаж' })).toHaveTextContent('неполный');
});
