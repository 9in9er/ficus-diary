import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import PlantPhoto from './PlantPhoto';
import PlantPhotoPreview from './PlantPhotoPreview';
import { photoRequest } from '../services/plantPhotos';
import { clearPlantPhotoCache } from '../services/plantPhotoCache';

jest.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { uid: 'owner' } }) }));
jest.mock('../services/plantPhotos', () => ({ photoRequest: jest.fn() }));

const originalObserver = global.IntersectionObserver;
let observers;
const plant = { id: 'plant', name: 'Ficus', photoKey: 'key' };
const enter = (index = 0) => act(() => observers[index].callback([{ isIntersecting: true }]));

beforeEach(() => {
  jest.clearAllMocks();
  clearPlantPhotoCache();
  photoRequest.mockResolvedValue({ url: '/signed.webp', expiresIn: 600 });
  observers = [];
  global.IntersectionObserver = jest.fn((callback, options) => {
    const observer = { callback, options, observe: jest.fn(), disconnect: jest.fn() };
    observers.push(observer);
    return observer;
  });
});
afterEach(() => {
  global.IntersectionObserver = originalObserver;
  jest.useRealTimers();
});

test('reserves photo space but requests nothing until its card is within 300px', async () => {
  const { container } = render(<article role='listitem'><PlantPhoto plant={plant} className='plantPhoto' /></article>);
  const placeholder = container.querySelector('img');
  expect(placeholder).not.toHaveAttribute('src');
  expect(placeholder).toHaveAttribute('width', '150');
  expect(placeholder).toHaveAttribute('height', '188');
  expect(placeholder.style.aspectRatio).toBe('4 / 5');
  expect(photoRequest).not.toHaveBeenCalled();
  expect(observers[0].options).toEqual({ rootMargin: '300px' });
  expect(observers[0].observe).toHaveBeenCalledWith(screen.getByRole('listitem'));
  act(() => observers[0].callback([{ isIntersecting: false }]));
  expect(photoRequest).not.toHaveBeenCalled();
  enter();
  const image = await screen.findByRole('img', { name: plant.name });
  expect(image).toHaveAttribute('src', '/signed.webp');
  expect(image).toHaveAttribute('decoding', 'async');
  expect(observers[0].disconnect).toHaveBeenCalled();
});

test.each(['https://external/plant.jpg', 'data:image/png;base64,AA=='])(
  'defers a direct source until intersection: %s', (photo) => {
    const { container } = render(<PlantPhoto plant={{ name: 'Direct', photo }} />);
    expect(container.querySelector('img')).not.toHaveAttribute('src');
    enter();
    expect(screen.getByRole('img', { name: 'Direct' })).toHaveAttribute('src', photo);
    expect(photoRequest).not.toHaveBeenCalled();
  }
);

test('reobserves a replaced source before first intersection and disconnects on unmount', () => {
  const { rerender, unmount } = render(<PlantPhoto plant={{ name: 'Direct', photo: 'https://external/old' }} />);
  rerender(<PlantPhoto plant={{ name: 'Direct', photo: 'https://external/new' }} />);
  expect(observers[0].disconnect).toHaveBeenCalled();
  expect(observers[1].observe).toHaveBeenCalled();
  enter(1);
  expect(screen.getByRole('img')).toHaveAttribute('src', 'https://external/new');
  unmount();
  expect(observers[1].disconnect).toHaveBeenCalled();
});

test('a visible card and an immediate editing preview share one pending request', async () => {
  let finish;
  photoRequest.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const { rerender } = render(<PlantPhoto plant={plant} />);
  enter();
  rerender(<><PlantPhoto plant={plant} /><PlantPhotoPreview plant={plant} /></>);
  expect(photoRequest).toHaveBeenCalledTimes(1);
  await act(async () => finish({ url: '/shared.webp', expiresIn: 600 }));
  expect(screen.getByRole('img', { name: plant.name })).toHaveAttribute('src', '/shared.webp');
  expect(screen.getByRole('img', { name: 'Предпросмотр фотографии' })).toHaveAttribute('src', '/shared.webp');
});

test('retains the image element and src past expiry, but displays a new photoKey', async () => {
  jest.useFakeTimers();
  const { rerender } = render(<PlantPhoto plant={plant} />);
  enter();
  await act(async () => {});
  const image = screen.getByRole('img', { name: plant.name });
  fireEvent.load(image);
  await act(async () => jest.advanceTimersByTime(1200000));
  rerender(<PlantPhoto plant={{ ...plant, name: 'Renamed' }} />);
  expect(screen.getByRole('img', { name: 'Renamed' })).toBe(image);
  expect(image).toHaveAttribute('src', '/signed.webp');
  expect(photoRequest).toHaveBeenCalledTimes(1);
  photoRequest.mockResolvedValueOnce({ url: '/replacement.webp', expiresIn: 600 });
  rerender(<PlantPhoto plant={{ ...plant, photoKey: 'replacement-key' }} />);
  await act(async () => {});
  expect(screen.getByRole('img', { name: plant.name })).toHaveAttribute('src', '/replacement.webp');
  expect(photoRequest).toHaveBeenCalledTimes(2);
});

test('an image error can obtain a fresh signed URL through the retry button', async () => {
  render(<PlantPhoto plant={plant} />);
  enter();
  fireEvent.error(await screen.findByRole('img', { name: plant.name }));
  expect(screen.getByRole('status')).toHaveTextContent('Не удалось загрузить фото');
  photoRequest.mockResolvedValueOnce({ url: '/retry.webp', expiresIn: 600 });
  fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
  await waitFor(() => expect(screen.getByRole('img', { name: plant.name })).toHaveAttribute('src', '/retry.webp'));
  expect(photoRequest).toHaveBeenCalledTimes(2);
});

test('loads eagerly without IntersectionObserver and does not reserve space for absent photos', async () => {
  delete global.IntersectionObserver;
  const { rerender, container } = render(<PlantPhoto plant={plant} />);
  expect(await screen.findByRole('img', { name: plant.name })).toHaveAttribute('src', '/signed.webp');
  rerender(<PlantPhoto plant={{ name: 'No photo' }} />);
  expect(container.querySelector('img')).toBeNull();
});

test('cards load thumbnails lazily and enlargement requests and caches the original only on opening', async () => {
  photoRequest.mockImplementation(async (_user, { variant }) => ({
    url: variant === 'thumbnail' ? '/thumbnail.webp' : '/original.webp', expiresIn: 600,
  }));
  const withThumbnail = { ...plant, photoThumbKey: 'thumb-key' };
  const { rerender } = render(<PlantPhoto plant={withThumbnail} />);
  expect(photoRequest).not.toHaveBeenCalled();
  enter();
  expect(await screen.findByRole('img', { name: plant.name })).toHaveAttribute('src', '/thumbnail.webp');
  expect(photoRequest).toHaveBeenCalledTimes(1);
  expect(photoRequest).toHaveBeenLastCalledWith(expect.anything(), { action: 'read', plantId: plant.id, variant: 'thumbnail' });
  fireEvent.click(screen.getByRole('button', { name: `Увеличить фото: ${plant.name}` }));
  const dialog = screen.getByRole('dialog', { name: plant.name });
  expect(await within(dialog).findByRole('img', { name: plant.name })).toHaveAttribute('src', '/original.webp');
  expect(photoRequest).toHaveBeenLastCalledWith(expect.anything(), { action: 'read', plantId: plant.id });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Закрыть' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('img', { name: plant.name })).toHaveAttribute('src', '/thumbnail.webp');
  fireEvent.click(screen.getByRole('button', { name: `Увеличить фото: ${plant.name}` }));
  expect(await within(screen.getByRole('dialog')).findByRole('img')).toHaveAttribute('src', '/original.webp');
  expect(photoRequest).toHaveBeenCalledTimes(2);
  // Replacing a photograph also dismisses an enlarged view of its old version.
  rerender(<PlantPhoto plant={{ ...withThumbnail, photoKey: 'new-original', photoThumbKey: 'new-thumb' }} />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await waitFor(() => expect(photoRequest).toHaveBeenCalledTimes(3));
});

test('stored-photo editing preview always requests the original even with a thumbnail', async () => {
  render(<PlantPhotoPreview plant={{ ...plant, photoThumbKey: 'thumb-key' }} />);
  expect(await screen.findByRole('img', { name: 'Предпросмотр фотографии' })).toHaveAttribute('src', '/signed.webp');
  expect(photoRequest).toHaveBeenCalledWith(expect.anything(), { action: 'read', plantId: plant.id });
  expect(observers).toHaveLength(0);
});

test('thumbnail-key changes invalidate the displayed source even when the original key is unchanged', async () => {
  photoRequest.mockResolvedValueOnce({ url: '/first-thumb.webp', expiresIn: 600 })
    .mockResolvedValueOnce({ url: '/second-thumb.webp', expiresIn: 600 });
  const { rerender } = render(<PlantPhoto plant={{ ...plant, photoThumbKey: 'first-thumb' }} />);
  enter();
  expect(await screen.findByRole('img', { name: plant.name })).toHaveAttribute('src', '/first-thumb.webp');
  rerender(<PlantPhoto plant={{ ...plant, photoThumbKey: 'second-thumb' }} />);
  await waitFor(() => expect(screen.getByRole('img', { name: plant.name })).toHaveAttribute('src', '/second-thumb.webp'));
  expect(photoRequest).toHaveBeenCalledTimes(2);
});
