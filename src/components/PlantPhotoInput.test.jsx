import { act, fireEvent, render, screen } from '@testing-library/react';
import usePlantDraft from '../hooks/usePlantDraft';
import PlantForm from './PlantForm';
import WishlistForm from './WishlistForm';
import PlantPhoto from './PlantPhoto';
import { resizePlantPhoto } from '../utils/resizePlantPhoto';
import { photoRequest } from '../services/plantPhotos';

jest.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: null }) }));
jest.mock('../services/plantPhotos', () => ({ photoRequest: jest.fn() }));
jest.mock('../utils/resizePlantPhoto', () => ({ resizePlantPhoto: jest.fn() }));
const url = 'https://images.example.com/image?id=123&format=webp';

function Harness({ wishlist = false, plant, onSave = jest.fn(), isSubmitting = false }) {
  const form = usePlantDraft();
  return <>
    <button onClick={() => form.resetDraft(plant)}>Редактировать</button>
    {wishlist ? <WishlistForm form={form} isSubmitting={isSubmitting} onSubmit={(event) => { event.preventDefault(); onSave(form.draft); }} onCancel={() => {}} />
      : <PlantForm photoForm={form} name={form.draft.name} acquiredAt={form.draft.acquiredAt}
        isSubmitting={isSubmitting} isProcessingPhoto={form.isProcessingPhoto} error={form.photoError}
        onNameChange={(value) => form.setField('name', value)} onDateChange={() => {}}
        onSubmit={(event) => { event.preventDefault(); onSave(form.draft); }} onCancel={() => {}} />}
  </>;
}

beforeEach(() => { jest.useFakeTimers(); jest.clearAllMocks(); });
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });
const showPreview = () => act(() => jest.advanceTimersByTime(350));

test.each([false, true])('URL preview validates protocol, permits extensionless links, and gates saving (wishlist=%s)', (wishlist) => {
  const save = jest.fn();
  render(<Harness wishlist={wishlist} onSave={save} />);
  fireEvent.change(screen.getByLabelText('Название растения'), { target: { value: 'Фикус' } });
  fireEvent.click(screen.getByRole('button', { name: 'Вставить ссылку' }));
  expect(screen.queryByLabelText('Фотография растения')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
  const input = screen.getByLabelText('Ссылка на изображение');
  for (const value of ['javascript:alert(1)', 'data:image/png;base64,AA==', 'ftp://example.com/plant', 'example.com/plant', 'https://']) {
    fireEvent.change(input, { target: { value } });
    expect(screen.getByRole('alert')).toHaveTextContent('Введите корректную ссылку');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    fireEvent.submit(screen.getByRole('form'));
    expect(save).not.toHaveBeenCalled();
  }
  fireEvent.change(input, { target: { value: `  ${url}  ` } });
  showPreview();
  const preview = screen.getByRole('img', { name: 'Предпросмотр фотографии' });
  expect(preview).toHaveAttribute('src', url);
  fireEvent.load(preview);
  act(() => jest.advanceTimersByTime(20000));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Сохранить' })).toBeEnabled();
  fireEvent.submit(screen.getByRole('form'));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ photoSource: 'url', photoUrl: expect.stringContaining(url), photoBlob: null }));
  expect(photoRequest).not.toHaveBeenCalled();
});

test('URL load errors and stalled loads show an explanation, support retry, and reset on URL change', () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Вставить ссылку' }));
  fireEvent.change(screen.getByLabelText('Ссылка на изображение'), { target: { value: url } });
  showPreview();
  fireEvent.error(screen.getByRole('img'));
  expect(screen.getByRole('alert')).toHaveTextContent('сайт может запрещать показ');
  expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
  showPreview();
  fireEvent.load(screen.getByRole('img'));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Ссылка на изображение'), { target: { value: 'http://example.com/new' } });
  act(() => jest.advanceTimersByTime(15000));
  expect(screen.getByRole('alert')).toHaveTextContent('Не удалось загрузить изображение');
  fireEvent.click(screen.getByRole('button', { name: 'Загрузить файл' }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Сохранить' })).toBeEnabled();
});

test.each([false, true])('editing detects URL photos and permits replacing with a file (wishlist=%s)', async (wishlist) => {
  jest.spyOn(URL, 'createObjectURL').mockReturnValue('blob:replacement');
  const blob = new Blob(['photo'], { type: 'image/webp' });
  resizePlantPhoto.mockResolvedValue(blob);
  const save = jest.fn();
  render(<Harness wishlist={wishlist} plant={{ id: 'plant', name: 'Фикус', photo: url }} onSave={save} />);
  fireEvent.click(screen.getByRole('button', { name: 'Редактировать' }));
  expect(screen.getByRole('button', { name: 'Вставить ссылку' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByLabelText('Ссылка на изображение')).toHaveValue(url);
  fireEvent.click(screen.getByRole('button', { name: 'Загрузить файл' }));
  await act(async () => fireEvent.change(screen.getByLabelText('Фотография растения'), {
    target: { files: [new File(['file'], 'plant.png', { type: 'image/png' })] },
  }));
  expect(screen.getByRole('img', { name: 'Предпросмотр фотографии' })).toHaveAttribute('src', 'blob:replacement');
  fireEvent.submit(screen.getByRole('form'));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ photoSource: 'file', photoBlob: blob }));
});

test('switching away from file upload ignores a late resize result and starts URL preview without an old storage read', async () => {
  let finish;
  resizePlantPhoto.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const save = jest.fn();
  render(<Harness plant={{ id: 'plant', name: 'Фикус', photoKey: 'stored-key' }} onSave={save} />);
  fireEvent.click(screen.getByRole('button', { name: 'Редактировать' }));
  expect(screen.getByRole('button', { name: 'Загрузить файл' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.change(screen.getByLabelText('Фотография растения'), { target: { files: [new File(['file'], 'plant.png')] } });
  fireEvent.click(screen.getByRole('button', { name: 'Вставить ссылку' }));
  await act(async () => finish(new Blob(['old'])));
  fireEvent.change(screen.getByLabelText('Ссылка на изображение'), { target: { value: url } });
  showPreview();
  fireEvent.load(screen.getByRole('img'));
  fireEvent.submit(screen.getByRole('form'));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ photoSource: 'url', photoBlob: null }));
});

test('saved external photos report hotlink failures and can retry without a storage API call', () => {
  render(<PlantPhoto plant={{ name: 'Фикус', photo: url }} />);
  fireEvent.error(screen.getByRole('img', { name: 'Фикус' }));
  expect(screen.getByRole('status')).toHaveTextContent('сайт запрещает его показ');
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
  expect(screen.getByRole('img', { name: 'Фикус' })).toHaveAttribute('src', url);
  expect(photoRequest).not.toHaveBeenCalled();
});

test.each([false, true])('clicking the drop zone opens the file picker without submitting (wishlist=%s)', (wishlist) => {
  const save = jest.fn();
  render(<Harness wishlist={wishlist} onSave={save} />);
  const fileInput = screen.getByLabelText('Фотография растения');
  const openPicker = jest.spyOn(fileInput, 'click');
  const dropzone = screen.getByRole('button', { name: /Перетащите изображение сюда/ });
  expect(dropzone).toHaveAttribute('type', 'button');
  fireEvent.click(dropzone);
  expect(openPicker).toHaveBeenCalledTimes(1);
  expect(save).not.toHaveBeenCalled();
});

test.each([false, true])('dropping an image highlights the zone and uses the existing photo pipeline (wishlist=%s)', async (wishlist) => {
  const file = new File(['photo'], 'plant.png', { type: 'image/png' });
  const blob = new Blob(['resized'], { type: 'image/webp' });
  let finishResize;
  resizePlantPhoto.mockImplementationOnce(() => new Promise((resolve) => { finishResize = resolve; }));
  const save = jest.fn();
  render(<Harness wishlist={wishlist} onSave={save} />);
  fireEvent.change(screen.getByLabelText('Название растения'), { target: { value: 'Фикус' } });
  const zone = screen.getByRole('button', { name: /Перетащите изображение сюда/ });
  const dataTransfer = { files: [file], types: ['Files'] };
  fireEvent.dragEnter(zone, { dataTransfer });
  expect(zone).toHaveClass('photoFileUpload--dragging');
  expect(zone).toHaveTextContent('Отпустите изображение здесь');
  fireEvent.dragOver(zone, { dataTransfer });
  expect(dataTransfer.dropEffect).toBe('copy');
  fireEvent.drop(zone, { dataTransfer });
  expect(zone).not.toHaveClass('photoFileUpload--dragging');
  expect(resizePlantPhoto).toHaveBeenCalledWith(file);
  expect(screen.getByRole('button', { name: 'Обрабатываем фото…' })).toBeDisabled();
  await act(async () => finishResize(blob));
  expect(screen.getByRole('img', { name: 'Предпросмотр фотографии' })).toHaveAttribute('src', expect.stringContaining('blob:'));
  fireEvent.submit(screen.getByRole('form'));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ photoSource: 'file', photoBlob: blob }));
  expect(photoRequest).not.toHaveBeenCalled();
});

test('dragging over nested elements keeps the highlight until the file leaves the zone', () => {
  render(<Harness />);
  const zone = screen.getByRole('button', { name: /Перетащите изображение сюда/ });
  const dataTransfer = { files: [], types: ['Files'] };
  fireEvent.dragEnter(zone, { dataTransfer });
  const hint = screen.getByText('или нажмите, чтобы выбрать файл');
  fireEvent.dragEnter(hint, { dataTransfer });
  fireEvent.dragLeave(hint, { dataTransfer });
  expect(zone).toHaveClass('photoFileUpload--dragging');
  fireEvent.dragLeave(zone, { dataTransfer });
  expect(zone).not.toHaveClass('photoFileUpload--dragging');
  fireEvent.dragEnter(zone, { dataTransfer: { files: [], types: ['text/plain'] } });
  expect(zone).not.toHaveClass('photoFileUpload--dragging');
});

test('disabled zones ignore clicks and dropped files while a plant is being saved', () => {
  render(<Harness isSubmitting />);
  const zone = screen.getByRole('button', { name: /Перетащите изображение сюда/ });
  const openPicker = jest.spyOn(screen.getByLabelText('Фотография растения'), 'click');
  const dataTransfer = { files: [new File(['photo'], 'plant.png', { type: 'image/png' })], types: ['Files'] };
  expect(zone).toBeDisabled();
  fireEvent.click(zone);
  fireEvent.dragEnter(zone, { dataTransfer });
  fireEvent.dragOver(zone, { dataTransfer });
  fireEvent.drop(zone, { dataTransfer });
  expect(zone).not.toHaveClass('photoFileUpload--dragging');
  expect(dataTransfer.dropEffect).toBe('none');
  expect(openPicker).not.toHaveBeenCalled();
  expect(resizePlantPhoto).not.toHaveBeenCalled();
});

test('empty drops do nothing and invalid files show the existing photo error', async () => {
  resizePlantPhoto.mockRejectedValueOnce(new Error('Not an image'));
  render(<Harness />);
  const zone = screen.getByRole('button', { name: /Перетащите изображение сюда/ });
  fireEvent.drop(zone, { dataTransfer: { files: [], types: [] } });
  expect(resizePlantPhoto).not.toHaveBeenCalled();
  await act(async () => fireEvent.drop(zone, { dataTransfer: {
    files: [new File(['text'], 'notes.txt', { type: 'text/plain' })], types: ['Files'],
  } }));
  expect(screen.getByRole('alert')).toHaveTextContent('Не удалось обработать фото');
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
});
