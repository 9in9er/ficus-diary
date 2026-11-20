import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { addDoc, deleteDoc, doc, onSnapshot, updateDoc } from 'firebase/firestore';
import PlantsPage from './PlantsPage';
import { getLocalDate } from '../utils/plantDates';
import { resizePlantPhoto } from '../utils/resizePlantPhoto';
import { photoRequest, savePlantPhoto } from '../services/plantPhotos';

jest.mock('../services/plantPhotos', () => ({ photoRequest: jest.fn(), savePlantPhoto: jest.fn() }));

jest.mock('../firebase', () => ({ db: {} }));
jest.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { uid: 'user-1' } }) }));
jest.mock('firebase/firestore', () => ({
  collection: jest.fn(), query: jest.fn(), where: jest.fn(), doc: jest.fn(),
  onSnapshot: jest.fn(), addDoc: jest.fn(), updateDoc: jest.fn(), deleteDoc: jest.fn(),
}));
jest.mock('../utils/resizePlantPhoto', () => ({ resizePlantPhoto: jest.fn(async () => 'data:image/png;base64,photo') }));
jest.mock('../i/icons/grid-3-columns.svg', () => ({ ReactComponent: () => <svg /> }));
jest.mock('../i/icons/grid-4-columns.svg', () => ({ ReactComponent: () => <svg /> }));
jest.mock('../i/icons/grid-8-columns.svg', () => ({ ReactComponent: () => <svg /> }));
jest.mock('../i/icons/grid-1-column.svg', () => ({ ReactComponent: () => <svg /> }));
jest.mock('../i/icons/grid-2-columns.svg', () => ({ ReactComponent: () => <svg /> }));

const wish = {
  id: 'wish-1', name: 'Алоказия фрайдек', photo: 'data:image/png;base64,photo',
  description: 'Вариегатная, небольшой куст', price: '1 500–2 000 ₽',
  links: ['https://example.com/plant'], isWishlisted: true,
  deletedAt: null, createdAt: '2026-11-18T12:00:00.000Z',
};
const ordinary = { id: 'plant-1', name: 'Мой фикус', wateringLog: [], fertilizingLog: [], notes: [] };
let records;
let listener;
const originalResizeObserver = window.ResizeObserver;
beforeAll(() => {
  window.ResizeObserver = class { observe() {} disconnect() {} };
});
afterAll(() => { window.ResizeObserver = originalResizeObserver; });
afterEach(() => { jest.restoreAllMocks(); });
const snapshot = () => ({ docs: records.map(({ id, ...data }) => ({ id, data: () => data })) });

function renderPage(path = '/wishlist') {
  return render(<MemoryRouter initialEntries={[path]}><Routes>
    <Route path='/wishlist' element={<PlantsPage key='wishlist' isWishlist />} />
    <Route path='/plants' element={<PlantsPage key='plants' />} />
  </Routes></MemoryRouter>);
}

beforeEach(() => {
  jest.resetAllMocks();
  localStorage.clear();
  records = [ordinary, wish];
  doc.mockImplementation((db, collection, id) => ({ id: id || 'new-wish' }));
  onSnapshot.mockImplementation((query, onSuccess) => {
    listener = onSuccess;
    onSuccess(snapshot());
    return jest.fn();
  });
  addDoc.mockResolvedValue({ id: 'new-wish' });
  resizePlantPhoto.mockResolvedValue(new Blob(['photo'], { type: 'image/webp' }));
  savePlantPhoto.mockResolvedValue({ photoKey: 'new-key' });
  photoRequest.mockResolvedValue({ deleted: true });
  updateDoc.mockImplementation(async ({ id }, changes) => {
    records = records.map((record) => record.id === id ? { ...record, ...changes } : record);
    listener(snapshot());
  });
  deleteDoc.mockResolvedValue();
});

test('separates wishlist and collection, displays details and hides care filters', () => {
  renderPage();
  expect(screen.getByRole('listitem', { name: wish.name })).toBeInTheDocument();
  expect(screen.queryByRole('listitem', { name: ordinary.name })).not.toBeInTheDocument();
  expect(screen.getByText(wish.description)).toBeInTheDocument();
  expect(screen.getByText(wish.price)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'example.com' })).toHaveAttribute('href', wish.links[0]);
  expect(screen.queryByRole('option', { name: /Полив:/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Скрытые' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('link', { name: 'Мои растения' }));
  expect(screen.getByRole('listitem', { name: ordinary.name })).toBeInTheDocument();
  expect(screen.queryByRole('listitem', { name: wish.name })).not.toBeInTheDocument();
});

test('adds a wish with a photo, optional details and normalized links', async () => {
  const createUrl = jest.spyOn(URL, 'createObjectURL').mockReturnValue('blob:new-wish');
  const revokeUrl = jest.spyOn(URL, 'revokeObjectURL');
  renderPage();
  fireEvent.click(screen.getByRole('button', { name: 'Добавить в вишлист' }));
  expect(screen.queryByLabelText('Дата появления')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Название растения'), { target: { value: '  Монстера  ' } });
  fireEvent.change(screen.getByLabelText('Описание'), { target: { value: 'Большие листья' } });
  fireEvent.change(screen.getByLabelText('Примерная цена'), { target: { value: 'около 3 000 ₽' } });
  fireEvent.change(screen.getByLabelText('Ссылки'), { target: { value: 'example.com/plant\nhttps://shop.example.com/item' } });
  await act(async () => fireEvent.change(screen.getByLabelText('Фотография растения'), {
    target: { files: [new File(['photo'], 'plant.png', { type: 'image/png' })] },
  }));
  expect(screen.getByRole('img', { name: 'Предпросмотр фотографии' })).toHaveAttribute('src', 'blob:new-wish');
  expect(createUrl).toHaveBeenCalledWith(expect.any(Blob));
  fireEvent.submit(screen.getByRole('form'));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(savePlantPhoto).toHaveBeenCalledWith({ uid: 'user-1' }, expect.objectContaining({
    plantId: 'new-wish', creating: true, isWishlisted: true,
    blob: expect.any(Blob), fields: {
      name: 'Монстера', description: 'Большие листья', price: 'около 3 000 ₽',
      links: ['https://example.com/plant', 'https://shop.example.com/item'],
    },
  }));
  expect(addDoc).not.toHaveBeenCalled();
  expect(revokeUrl).toHaveBeenCalledWith('blob:new-wish');
});

test('edits a key-only wish with a temporary-link preview and preserves the key without recreating photo', async () => {
  const { photo, ...withoutPhoto } = wish;
  records = [ordinary, { ...withoutPhoto, photoKey: 'published-key' }];
  photoRequest.mockResolvedValue({ url: '/published-wish.webp', expiresIn: 600 });
  renderPage();
  await screen.findByRole('img', { name: wish.name });
  fireEvent.click(screen.getByRole('button', { name: 'Редактировать' }));
  expect(await screen.findByRole('img', { name: 'Предпросмотр фотографии' })).toHaveAttribute('src', '/published-wish.webp');
  expect(screen.getByRole('img', { name: 'Предпросмотр фотографии' })).toHaveClass('wishlistPhotoPreview');
  fireEvent.change(screen.getByLabelText('Описание'), { target: { value: 'Changed without legacy photo' } });
  fireEvent.submit(screen.getByRole('form'));
  await waitFor(() => expect(screen.queryByRole('form')).not.toBeInTheDocument());
  expect(updateDoc).toHaveBeenCalledWith({ id: wish.id }, {
    name: wish.name, description: 'Changed without legacy photo', price: wish.price, links: wish.links,
  });
  const saved = records.find((record) => record.id === wish.id);
  expect(saved.photoKey).toBe('published-key');
  expect(saved).not.toHaveProperty('photo');
  expect(savePlantPhoto).not.toHaveBeenCalled();
});

test('replaces a key-only photo, ignores late read results, and revokes local previews on replacement and save', async () => {
  const { photo, ...withoutPhoto } = wish;
  records = [ordinary, { ...withoutPhoto, photoKey: 'published-key' }];
  const firstBlob = new Blob(['first'], { type: 'image/webp' });
  const secondBlob = new Blob(['second'], { type: 'image/webp' });
  resizePlantPhoto.mockResolvedValueOnce(firstBlob).mockResolvedValueOnce(secondBlob);
  jest.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:replacement-first').mockReturnValueOnce('blob:replacement-second');
  const revoke = jest.spyOn(URL, 'revokeObjectURL');
  photoRequest.mockResolvedValue({ url: '/original-wish.webp', expiresIn: 600 });
  renderPage();
  await screen.findByRole('img', { name: wish.name });
  let finishOldRead;
  photoRequest.mockImplementationOnce(() => new Promise((resolve) => { finishOldRead = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: 'Редактировать' }));
  await act(async () => fireEvent.change(screen.getByLabelText('Фотография растения'), {
    target: { files: [new File(['first'], 'first.png', { type: 'image/png' })] },
  }));
  expect(screen.getByRole('img', { name: 'Предпросмотр фотографии' })).toHaveAttribute('src', 'blob:replacement-first');
  await act(async () => finishOldRead({ url: '/late-old-wish.webp', expiresIn: 600 }));
  expect(screen.getByRole('img', { name: 'Предпросмотр фотографии' })).toHaveAttribute('src', 'blob:replacement-first');
  await act(async () => fireEvent.change(screen.getByLabelText('Фотография растения'), {
    target: { files: [new File(['second'], 'second.png', { type: 'image/png' })] },
  }));
  expect(revoke).toHaveBeenCalledWith('blob:replacement-first');
  expect(screen.getByRole('img', { name: 'Предпросмотр фотографии' })).toHaveAttribute('src', 'blob:replacement-second');
  savePlantPhoto.mockImplementationOnce(async () => {
    records = records.map((record) => record.id === wish.id ? { ...record, photoKey: 'replacement-key' } : record);
    listener(snapshot());
    return { photoKey: 'replacement-key' };
  });
  fireEvent.submit(screen.getByRole('form'));
  await waitFor(() => expect(screen.queryByRole('form')).not.toBeInTheDocument());
  expect(savePlantPhoto).toHaveBeenCalledWith({ uid: 'user-1' }, expect.objectContaining({
    plantId: wish.id, blob: secondBlob, creating: false,
  }));
  const fields = savePlantPhoto.mock.calls[0][1].fields;
  expect(fields).not.toHaveProperty('photo');
  expect(fields).not.toHaveProperty('photoKey');
  expect(revoke).toHaveBeenCalledWith('blob:replacement-second');
  expect(records.find((record) => record.id === wish.id)).not.toHaveProperty('photo');
  expect(records.find((record) => record.id === wish.id).isWishlisted).toBe(true);
  expect(deleteDoc).not.toHaveBeenCalled();
});

test('cancelling a photo replacement restores the key-only stored preview and releases the local Blob URL', async () => {
  const { photo, ...withoutPhoto } = wish;
  records = [ordinary, { ...withoutPhoto, photoKey: 'published-key' }];
  jest.spyOn(URL, 'createObjectURL').mockReturnValue('blob:cancelled-replacement');
  const revoke = jest.spyOn(URL, 'revokeObjectURL');
  photoRequest.mockResolvedValue({ url: '/published-wish.webp', expiresIn: 600 });
  renderPage();
  await screen.findByRole('img', { name: wish.name });
  fireEvent.click(screen.getByRole('button', { name: 'Редактировать' }));
  await act(async () => fireEvent.change(screen.getByLabelText('Фотография растения'), {
    target: { files: [new File(['photo'], 'new.png', { type: 'image/png' })] },
  }));
  await screen.findByRole('img', { name: 'Предпросмотр фотографии' });
  fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
  expect(revoke).toHaveBeenCalledWith('blob:cancelled-replacement');
  fireEvent.click(screen.getByRole('button', { name: 'Редактировать' }));
  expect(await screen.findByRole('img', { name: 'Предпросмотр фотографии' })).toHaveAttribute('src', '/published-wish.webp');
  expect(savePlantPhoto).not.toHaveBeenCalled();
});

test('acquiring a key-only wish keeps its photograph in the collection without legacy photo', async () => {
  const { photo, ...withoutPhoto } = wish;
  records = [ordinary, { ...withoutPhoto, photoKey: 'published-key' }];
  photoRequest.mockResolvedValue({ url: '/published-wish.webp', expiresIn: 600 });
  renderPage();
  await screen.findByRole('img', { name: wish.name });
  fireEvent.click(screen.getByRole('button', { name: 'Уже у меня' }));
  await waitFor(() => expect(screen.queryByRole('listitem')).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole('link', { name: 'Мои растения' }));
  const image = await screen.findByRole('img', { name: wish.name });
  expect(image).toHaveAttribute('src', '/published-wish.webp');
  const saved = records.find((record) => record.id === wish.id);
  expect(saved.photoKey).toBe('published-key');
  expect(saved).not.toHaveProperty('photo');
  expect(saved.isWishlisted).toBe(false);
  expect(savePlantPhoto).not.toHaveBeenCalled();
  expect(deleteDoc).not.toHaveBeenCalled();
});

test('legacy wishlist photographs in trash remain visible without temporary-link requests', () => {
  records = [ordinary, { ...wish, deletedAt: '2026-11-19T12:00:00Z' }];
  renderPage();
  fireEvent.click(screen.getByRole('button', { name: 'Корзина · 1' }));
  expect(screen.getByRole('img', { name: wish.name })).toHaveAttribute('src', wish.photo);
  expect(photoRequest).not.toHaveBeenCalled();
});

test('keeps an unsaved wish on error, rejects unsafe links, and allows retrying', async () => {
  renderPage();
  fireEvent.click(screen.getByRole('button', { name: 'Добавить в вишлист' }));
  fireEvent.change(screen.getByLabelText('Название растения'), { target: { value: 'Монстера' } });
  fireEvent.change(screen.getByLabelText('Ссылки'), { target: { value: 'javascript:alert(1)' } });
  fireEvent.submit(screen.getByRole('form'));
  expect(await screen.findByRole('alert')).toHaveTextContent('Укажите корректные ссылки');
  expect(addDoc).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Ссылки'), { target: { value: '' } });
  addDoc.mockRejectedValueOnce(new Error('offline'));
  fireEvent.submit(screen.getByRole('form'));
  expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось сохранить растение');
  expect(screen.getByLabelText('Название растения')).toHaveValue('Монстера');
  fireEvent.submit(screen.getByRole('form'));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(addDoc).toHaveBeenCalledTimes(2);
});

test('edits all wishlist fields and preserves the draft after a rejected save', async () => {
  renderPage();
  fireEvent.click(screen.getByRole('button', { name: 'Редактировать' }));
  expect(screen.getByLabelText('Ссылки')).toHaveValue(wish.links[0]);
  fireEvent.change(screen.getByLabelText('Описание'), { target: { value: 'Новый сорт' } });
  fireEvent.change(screen.getByLabelText('Примерная цена'), { target: { value: '800 ₽' } });
  updateDoc.mockRejectedValueOnce(new Error('offline'));
  fireEvent.submit(screen.getByRole('form'));
  expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось сохранить изменения');
  expect(screen.getByLabelText('Описание')).toHaveValue('Новый сорт');
  fireEvent.submit(screen.getByRole('form'));
  await waitFor(() => expect(screen.queryByRole('form')).not.toBeInTheDocument());
  expect(screen.getByText('Новый сорт')).toBeInTheDocument();
  expect(screen.getByText('800 ₽')).toBeInTheDocument();
});

test('moves the same record into the collection with today’s date and shows a regular plant card', async () => {
  renderPage();
  fireEvent.click(screen.getByRole('button', { name: 'Уже у меня' }));
  await waitFor(() => expect(screen.queryByRole('listitem')).not.toBeInTheDocument());
  expect(addDoc).not.toHaveBeenCalled();
  expect(deleteDoc).not.toHaveBeenCalled();
  expect(updateDoc).toHaveBeenCalledTimes(1);
  expect(updateDoc).toHaveBeenCalledWith({ id: wish.id }, expect.objectContaining({
    isWishlisted: false, acquiredAt: getLocalDate(), wateringLog: [], fertilizingLog: [], notes: [],
  }));
  fireEvent.click(screen.getByRole('link', { name: 'Мои растения' }));
  const card = within(screen.getByRole('listitem', { name: wish.name }));
  expect(card.queryByText(wish.description)).not.toBeInTheDocument();
  expect(card.queryByText(wish.price)).not.toBeInTheDocument();
  expect(card.queryByRole('link', { name: 'example.com' })).not.toBeInTheDocument();
  expect(card.getByRole('img', { name: wish.name })).toHaveAttribute('src', wish.photo);
  expect(card.getByRole('button', { name: 'iconEmojiDroplet' })).toBeEnabled();
  expect(card.getByText(/Дата появления/).parentElement).toHaveTextContent(new Date().toLocaleDateString('ru-RU'));
});

test('locks a pending transfer and leaves the wish available after failure', async () => {
  let reject;
  updateDoc.mockImplementationOnce(() => new Promise((resolve, rejectSave) => { reject = rejectSave; }));
  renderPage();
  const trigger = screen.getByRole('button', { name: 'Уже у меня' });
  fireEvent.click(trigger);
  fireEvent.click(trigger);
  expect(updateDoc).toHaveBeenCalledTimes(1);
  expect(trigger).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Редактировать' })).toBeDisabled();
  await act(async () => reject(new Error('offline')));
  expect(screen.getByRole('alert')).toHaveTextContent('Не удалось перенести растение');
  expect(trigger).toBeEnabled();
  expect(screen.getByRole('listitem', { name: wish.name })).toBeInTheDocument();
  fireEvent.click(trigger);
  await waitFor(() => expect(screen.queryByRole('listitem')).not.toBeInTheDocument());
});

test('moves a wish to its own trash and restores it into the wishlist', async () => {
  renderPage();
  fireEvent.click(screen.getByRole('button', { name: 'Удалить' }));
  await waitFor(() => expect(screen.queryByRole('listitem')).not.toBeInTheDocument());
  expect(deleteDoc).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Корзина · 1' }));
  expect(screen.getByText(/остаются в корзине до окончательного удаления/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Уже у меня' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Восстановить' }));
  await waitFor(() => expect(screen.queryByRole('listitem')).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: 'Все желания Все' }));
  expect(screen.getByRole('listitem', { name: wish.name })).toBeInTheDocument();
  expect(records.find((record) => record.id === wish.id).isWishlisted).toBe(true);
});

test('confirms permanent deletion and supports cancelling it', async () => {
  records = [{ ...wish, deletedAt: new Date().toISOString() }, ordinary];
  renderPage();
  fireEvent.click(screen.getByRole('button', { name: 'Корзина · 1' }));
  fireEvent.click(screen.getByRole('button', { name: 'Удалить навсегда' }));
  expect(deleteDoc).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Отмена' }));
  expect(deleteDoc).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Удалить навсегда' }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Удалить навсегда' }));
  await waitFor(() => expect(photoRequest).toHaveBeenCalledWith({ uid: 'user-1' }, { action: 'delete', plantId: wish.id }));
  expect(deleteDoc).not.toHaveBeenCalled();
});

test('searches and sorts wishes and keeps collection sorting independent', () => {
  records.push({ ...wish, id: 'wish-2', name: 'Бегония', createdAt: '2026-11-19T12:00:00.000Z' });
  localStorage.setItem('plantsSortMode', 'watering');
  renderPage();
  expect(screen.getByRole('combobox')).toHaveValue('date');
  expect(screen.getAllByRole('listitem', { name: /Алоказия|Бегония/ })[0]).toHaveAccessibleName('Бегония');
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'name' } });
  expect(screen.getAllByRole('listitem', { name: /Алоказия|Бегония/ })[0]).toHaveAccessibleName(wish.name);
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'бегония' } });
  expect(screen.getAllByRole('listitem', { name: /Алоказия|Бегония/ })).toHaveLength(1);
  fireEvent.click(screen.getByRole('link', { name: 'Мои растения' }));
  expect(screen.getByRole('combobox')).toHaveValue('watering');
});
