import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { onSnapshot, doc, updateDoc } from 'firebase/firestore';
import usePlantEditor from './usePlantEditor';
import { usePlants } from './usePlants';
import PlantPhoto from '../components/PlantPhoto';
import WishlistCard from '../components/WishlistCard';
import { photoRequest, savePlantPhoto } from '../services/plantPhotos';
import { clearPlantPhotoCache } from '../services/plantPhotoCache';

const mockUser = { uid: 'test-owner' };
jest.mock('../firebase', () => ({ db: {} }));
jest.mock('./useAuth', () => ({ useAuth: () => ({ user: mockUser }) }));
jest.mock('../services/plantPhotos', () => ({ photoRequest: jest.fn(), savePlantPhoto: jest.fn() }));
jest.mock('firebase/firestore', () => ({
  collection: jest.fn(), query: jest.fn(), where: jest.fn(), doc: jest.fn(),
  onSnapshot: jest.fn(), updateDoc: jest.fn(), addDoc: jest.fn(),
}));

const cleanedWish = { id: 'wish', name: 'Test wish', userId: 'test-owner', photoKey: 'test-object-key',
  isWishlisted: true, description: 'details', price: '100', links: [], deletedAt: null };

function WishlistHarness({ plant }) {
  const editor = usePlantEditor();
  return <WishlistCard plant={plant} editor={editor} actions={{ saveWish: jest.fn() }}
    isPending={false} isTrash={false} runAction={async (action) => { await action(); return true; }} onAcquired={() => {}} />;
}

beforeEach(() => {
  jest.clearAllMocks();
  clearPlantPhotoCache();
  photoRequest.mockResolvedValue({ url: '/test-object-photo.webp', expiresIn: 600 });
  doc.mockImplementation((_db, _collection, id) => ({ id }));
  onSnapshot.mockImplementation((_query, callback) => {
    callback({ docs: [{ id: cleanedWish.id, data: () => cleanedWish }] });
    return jest.fn();
  });
  updateDoc.mockResolvedValue();
});

test('collection and wishlist photo display resolves a key without any legacy photo', async () => {
  render(<><PlantPhoto plant={{ id: 'ordinary', name: 'Test plant', photoKey: 'ordinary-object-key' }} />
    <PlantPhoto plant={cleanedWish} /></>);
  await waitFor(() => expect(screen.getByRole('img', { name: 'Test plant' })).toHaveAttribute('src', '/test-object-photo.webp'));
  expect(screen.getByRole('img', { name: cleanedWish.name })).toHaveAttribute('src', '/test-object-photo.webp');
  expect(photoRequest).toHaveBeenCalledWith(expect.anything(), { action: 'read', plantId: cleanedWish.id });
});

test.each([false, true])('after base64 cleanup cards prefer thumbnail while preview keeps original (trash=%s)', async (trash) => {
  const cleaned = { ...cleanedWish, photoThumbKey: 'thumbnail-key', deletedAt: trash ? '2026-11-20' : null };
  photoRequest.mockImplementation(async (_user, body) => ({
    url: body.variant === 'thumbnail' ? '/thumbnail.webp' : '/original.webp', expiresIn: 600,
  }));
  const { rerender } = render(<PlantPhoto plant={cleaned} />);
  expect(await screen.findByRole('img', { name: cleaned.name })).toHaveAttribute('src', '/thumbnail.webp');
  expect(photoRequest).toHaveBeenCalledWith(mockUser, { action: 'read', plantId: cleaned.id, variant: 'thumbnail' });
  rerender(<WishlistHarness plant={cleaned} />);
  await screen.findByRole('img', { name: cleaned.name });
  // A restored document retains both keys; editing uses the main version.
  rerender(<WishlistHarness plant={{ ...cleaned, deletedAt: null }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Редактировать' }));
  expect(await screen.findByRole('img', { name: 'Предпросмотр фотографии' })).toHaveAttribute('src', '/original.webp');
  expect(photoRequest).toHaveBeenCalledWith(mockUser, { action: 'read', plantId: cleaned.id });
});

test('wishlist editing resolves a preview by photoKey even when photo is completely absent', async () => {
  render(<WishlistHarness plant={cleanedWish} />);
  await screen.findByRole('img', { name: cleanedWish.name });
  fireEvent.click(screen.getByRole('button', { name: 'Редактировать' }));
  expect(screen.getByRole('form', { name: 'Данные растения в вишлисте' })).toBeInTheDocument();
  expect(await screen.findByRole('img', { name: 'Предпросмотр фотографии' })).toHaveAttribute('src', '/test-object-photo.webp');
  expect(photoRequest).toHaveBeenCalledWith(mockUser, { action: 'read', plantId: cleanedWish.id });
});

test('wishlist editing retains legacy preview support without any photoKey or storage read', async () => {
  const { photoKey, ...legacyWish } = cleanedWish;
  render(<WishlistHarness plant={{ ...legacyWish, photo: 'data:image/png;base64,AA==' }} />);
  await screen.findByRole('img', { name: cleanedWish.name });
  fireEvent.click(screen.getByRole('button', { name: 'Редактировать' }));
  expect(screen.getByRole('img', { name: 'Предпросмотр фотографии' })).toHaveAttribute('src', 'data:image/png;base64,AA==');
  expect(photoRequest).not.toHaveBeenCalled();
});

test('preview can retry a failed temporary-link request without relying on base64', async () => {
  render(<WishlistHarness plant={cleanedWish} />);
  await screen.findByRole('img', { name: cleanedWish.name });
  clearPlantPhotoCache();
  photoRequest.mockRejectedValueOnce(new Error('offline'));
  fireEvent.click(screen.getByRole('button', { name: 'Редактировать' }));
  await screen.findByText('Не удалось загрузить фото.');
  fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
  expect(await screen.findByRole('img', { name: 'Предпросмотр фотографии' })).toHaveAttribute('src', '/test-object-photo.webp');
});

test('metadata editing for collection/wishlist without legacy photo never rewrites photo or photoKey', async () => {
  const { result } = renderHook(() => usePlants({ uid: 'test-owner' }));
  await act(async () => {
    await result.current.actions.savePlant('ordinary', { name: 'Renamed', acquiredAt: '' });
    await result.current.actions.saveWish(cleanedWish.id, { name: 'Renamed wish', description: 'new', price: '', links: '' });
  });
  expect(updateDoc).toHaveBeenCalledWith({ id: 'ordinary' }, { name: 'Renamed', acquiredAt: '' });
  expect(updateDoc).toHaveBeenCalledWith({ id: cleanedWish.id }, { name: 'Renamed wish', description: 'new', price: '', links: [] });
  for (const [, patch] of updateDoc.mock.calls) {
    expect(patch).not.toHaveProperty('photo');
    expect(patch).not.toHaveProperty('photoKey');
  }
  expect(savePlantPhoto).not.toHaveBeenCalled();
});
