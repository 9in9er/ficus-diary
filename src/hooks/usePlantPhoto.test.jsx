import { act, renderHook, waitFor } from '@testing-library/react';
import usePlantPhoto from './usePlantPhoto';
import { photoRequest } from '../services/plantPhotos';
import { clearPlantPhotoCache } from '../services/plantPhotoCache';

const mockUser = { uid: 'owner' };
jest.mock('./useAuth', () => ({ useAuth: () => ({ user: mockUser }) }));
jest.mock('../services/plantPhotos', () => ({ photoRequest: jest.fn() }));

beforeEach(() => { jest.clearAllMocks(); clearPlantPhotoCache(); });

test('legacy photo renders without any API/storage request', () => {
  const { result } = renderHook(() => usePlantPhoto({ id: 'old', photo: 'data:image/png;base64,AA==' }));
  expect(result.current.src).toBe('data:image/png;base64,AA==');
  expect(photoRequest).not.toHaveBeenCalled();
});

test('prefers signed URL, falls back to legacy on failure, and permits retry', async () => {
  const plant = { id: 'plant', photoKey: 'key', photo: 'legacy' };
  photoRequest.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ url: 'https://storage.invalid/signed', expiresIn: 600 });
  const { result } = renderHook(() => usePlantPhoto(plant));
  await waitFor(() => expect(result.current.failed).toBe(true));
  expect(result.current.src).toBe('legacy');
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.src).toBe('https://storage.invalid/signed'));
  expect(photoRequest).toHaveBeenCalledWith(mockUser, { action: 'read', plantId: 'plant' });
});

test('keeps a displayed URL after expiry and ignores a late response after photo replacement', async () => {
  jest.useFakeTimers();
  try {
    photoRequest.mockResolvedValue({ url: 'first', expiresIn: 600 });
    const { result, rerender, unmount } = renderHook((plant) => usePlantPhoto(plant), { initialProps: { id: 'plant', photoKey: 'key' } });
    await act(async () => {});
    expect(result.current.src).toBe('first');
    await act(async () => jest.advanceTimersByTime(1200000));
    expect(photoRequest).toHaveBeenCalledTimes(1);
    rerender({ id: 'plant', photoKey: 'key', name: 'Renamed' });
    expect(result.current.src).toBe('first');
    expect(photoRequest).toHaveBeenCalledTimes(1);
    let finishOld;
    photoRequest.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
    act(() => result.current.retry());
    photoRequest.mockResolvedValue({ url: 'new-photo', expiresIn: 600 });
    rerender({ id: 'plant', photoKey: 'new-key' });
    await act(async () => {});
    await act(async () => finishOld({ url: 'late-old-photo', expiresIn: 600 }));
    expect(result.current.src).toBe('new-photo');
    unmount();
    const requestsAtUnmount = photoRequest.mock.calls.length;
    await act(async () => jest.advanceTimersByTime(600000));
    expect(photoRequest).toHaveBeenCalledTimes(requestsAtUnmount);
  } finally { jest.useRealTimers(); }
});

test('defers storage, external and legacy sources until enabled', async () => {
  photoRequest.mockResolvedValue({ url: 'signed', expiresIn: 600 });
  const { result, rerender } = renderHook(({ plant, enabled }) => usePlantPhoto(plant, enabled), {
    initialProps: { plant: { id: 'plant', photoKey: 'key', photo: 'legacy' }, enabled: false },
  });
  expect(result.current.src).toBeNull();
  expect(photoRequest).not.toHaveBeenCalled();
  rerender({ plant: { id: 'plant', photoKey: 'key', photo: 'legacy' }, enabled: true });
  // Do not download the legacy source while obtaining the preferred storage URL.
  expect(result.current.src).toBeNull();
  await waitFor(() => expect(result.current.src).toBe('signed'));
  rerender({ plant: { photo: 'https://external/image' }, enabled: false });
  expect(result.current.src).toBeNull();
  rerender({ plant: { photo: 'https://external/image' }, enabled: true });
  expect(result.current.src).toBe('https://external/image');
});

test('reuses valid URLs on remount and fetches a fresh one on remount after expiry', async () => {
  jest.useFakeTimers();
  try {
    photoRequest.mockResolvedValueOnce({ url: 'first', expiresIn: 600 })
      .mockResolvedValueOnce({ url: 'fresh', expiresIn: 600 });
    const plant = { id: 'plant', photoKey: 'key' };
    const first = renderHook(() => usePlantPhoto(plant));
    await act(async () => {});
    first.unmount();
    const second = renderHook(() => usePlantPhoto(plant));
    await act(async () => {});
    expect(second.result.current.src).toBe('first');
    expect(photoRequest).toHaveBeenCalledTimes(1);
    second.unmount();
    act(() => jest.advanceTimersByTime(600000));
    const third = renderHook(() => usePlantPhoto(plant));
    await act(async () => {});
    expect(third.result.current.src).toBe('fresh');
    expect(photoRequest).toHaveBeenCalledTimes(2);
  } finally { jest.useRealTimers(); }
});

test('retains automatic retry after an API error without refreshing successful photos', async () => {
  jest.useFakeTimers();
  try {
    photoRequest.mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ url: 'recovered', expiresIn: 600 });
    const { result } = renderHook(() => usePlantPhoto({ id: 'plant', photoKey: 'key' }));
    await act(async () => {});
    expect(result.current.failed).toBe(true);
    await act(async () => jest.advanceTimersByTime(30000));
    expect(result.current.src).toBe('recovered');
    await act(async () => jest.advanceTimersByTime(1200000));
    expect(photoRequest).toHaveBeenCalledTimes(2);
  } finally { jest.useRealTimers(); }
});
