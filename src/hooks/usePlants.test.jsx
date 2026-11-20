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

test.each(['savePlant', 'saveWish'])('%s metadata never writes photo or photoKey, including null and undefined', async (action) => {
  const { result } = renderHook(() => usePlants(user));
  for (const extra of [{}, { photo: null }, { photo: undefined }]) {
    await result.current.actions[action]('plant', { name: 'Ficus', acquiredAt: '', photoKey: 'stored-key', ...extra });
  }
  expect(updateDoc).toHaveBeenCalledTimes(3);
  for (const [ref, fields] of updateDoc.mock.calls) {
    expect(ref).toEqual({ id: 'plant' });
    expect(fields.name).toBe('Ficus');
    expect(fields).not.toHaveProperty('photo');
    expect(fields).not.toHaveProperty('photoKey');
  }
  expect(savePlantPhoto).not.toHaveBeenCalled();
});

test.each(['createPlant', 'createWish'])('%s without a file never writes photo, photoKey, or photoBlob', async (action) => {
  const { result } = renderHook(() => usePlants(user));
  await result.current.actions[action]({ name: 'Ficus', acquiredAt: '', photoKey: null, photoBlob: null });
  expect(addDoc).toHaveBeenCalledTimes(1);
  const fields = addDoc.mock.calls[0][1];
  expect(fields).not.toHaveProperty('photo');
  expect(fields).not.toHaveProperty('photoKey');
  expect(fields).not.toHaveProperty('photoBlob');
  expect(savePlantPhoto).not.toHaveBeenCalled();
});

test.each(['createPlant', 'createWish', 'savePlant', 'saveWish'])('%s with a file sends only metadata fields to the photo service', async (action) => {
  const draft = { name: 'Ficus', acquiredAt: '', photoKey: 'stored-key', photoBlob: new Blob(['webp'], { type: 'image/webp' }) };
  const { result } = renderHook(() => usePlants(user));
  if (action.startsWith('create')) await result.current.actions[action](draft);
  else await result.current.actions[action]('plant', draft);
  expect(savePlantPhoto).toHaveBeenCalledTimes(1);
  const options = savePlantPhoto.mock.calls[0][1];
  expect(options.blob).toBe(draft.photoBlob);
  expect(options.fields.name).toBe('Ficus');
  expect(options.fields).not.toHaveProperty('photo');
  expect(options.fields).not.toHaveProperty('photoKey');
  expect(options.fields).not.toHaveProperty('photoBlob');
  expect(addDoc).not.toHaveBeenCalled();
  expect(updateDoc).not.toHaveBeenCalled();
});

test('opening old trash never automatically deletes records; permanent deletion uses API', async () => {
  onSnapshot.mockImplementation((query, cb) => {
    cb({ docs: [{ id: 'old-trash', data: () => ({ name: 'Ficus', deletedAt: '2020-01-01', photoKey: 'stored-key' }) }] });
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
