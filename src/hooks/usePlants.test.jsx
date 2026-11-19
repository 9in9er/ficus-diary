import { act, renderHook } from '@testing-library/react';
import { addDoc, doc, onSnapshot, updateDoc, deleteDoc } from 'firebase/firestore';
import { usePlants } from './usePlants';
import { photoRequest, savePlantPhoto } from '../services/plantPhotos';

jest.mock('../firebase', () => ({ db: {} }));
jest.mock('../services/plantPhotos', () => ({ photoRequest: jest.fn(), savePlantPhoto: jest.fn() }));
jest.mock('firebase/firestore', () => ({
  collection: jest.fn(), query: jest.fn(), where: jest.fn(), doc: jest.fn(),
  onSnapshot: jest.fn(), addDoc: jest.fn(), updateDoc: jest.fn(), deleteDoc: jest.fn(),
}));
const user = { uid: 'owner' };
beforeEach(() => {
  jest.resetAllMocks();
  doc.mockImplementation((db, collection, id) => ({ id: id || 'new-id' }));
  onSnapshot.mockImplementation((query, cb) => { cb({ docs: [] }); return jest.fn(); });
  savePlantPhoto.mockResolvedValue({ photoKey: 'new-key' });
  updateDoc.mockResolvedValue();
});

test('new plant with photo keeps its ID on retry and does not create a partial document', async () => {
  const draft = { name: 'Ficus', acquiredAt: '', photoBlob: new Blob(['webp'], { type: 'image/webp' }) };
  savePlantPhoto.mockRejectedValueOnce(new Error('offline'));
  const { result } = renderHook(() => usePlants(user));
  await expect(result.current.actions.createPlant(draft)).rejects.toThrow();
  await result.current.actions.createPlant({ ...draft, name: 'Ficus retry' });
  expect(savePlantPhoto.mock.calls.map((call) => call[1].plantId)).toEqual(['new-id', 'new-id']);
  expect(savePlantPhoto.mock.calls[1][1].fields.name).toBe('Ficus retry');
  expect(addDoc).not.toHaveBeenCalled();
});

test('editing metadata never rewrites old base64 or photoKey', async () => {
  const { result } = renderHook(() => usePlants(user));
  await result.current.actions.savePlant('plant', { name: 'Ficus', acquiredAt: '', photo: 'legacy-base64', photoKey: 'old-key' });
  expect(updateDoc).toHaveBeenCalledWith({ id: 'plant' }, { name: 'Ficus', acquiredAt: '' });
  expect(savePlantPhoto).not.toHaveBeenCalled();
});

test('opening old trash never automatically deletes records; permanent deletion uses API', async () => {
  onSnapshot.mockImplementation((query, cb) => {
    cb({ docs: [{ id: 'old-trash', data: () => ({ name: 'Ficus', deletedAt: '2020-01-01', photo: 'legacy' }) }] });
    return jest.fn();
  });
  const { result } = renderHook(() => usePlants(user));
  await act(async () => {});
  expect(deleteDoc).not.toHaveBeenCalled();
  expect(photoRequest).not.toHaveBeenCalled();
  await result.current.actions.permanentlyDeletePlant('old-trash');
  expect(photoRequest).toHaveBeenCalledWith(user, { action: 'delete', plantId: 'old-trash' });
  expect(deleteDoc).not.toHaveBeenCalled();
});
