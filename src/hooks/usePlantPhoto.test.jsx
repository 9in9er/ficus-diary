import { act, renderHook, waitFor } from '@testing-library/react';
import usePlantPhoto from './usePlantPhoto';
import { photoRequest } from '../services/plantPhotos';

const mockUser = { uid: 'owner' };
jest.mock('./useAuth', () => ({ useAuth: () => ({ user: mockUser }) }));
jest.mock('../services/plantPhotos', () => ({ photoRequest: jest.fn() }));

beforeEach(() => { jest.clearAllMocks(); });

test('a plant without a photo has no source, error, or API/storage request', () => {
  const { result } = renderHook(() => usePlantPhoto({ id: 'plant' }));
  expect(result.current.src).toBeNull();
  expect(result.current.failed).toBe(false);
  expect(photoRequest).not.toHaveBeenCalled();
});

test('obsolete photo data is ignored when photoKey is absent', () => {
  const { result } = renderHook(() => usePlantPhoto({ id: 'plant', photo: 'obsolete' }));
  expect(result.current.src).toBeNull();
  expect(photoRequest).not.toHaveBeenCalled();
});

test('a failed signed URL request has no image source and permits retry', async () => {
  const plant = { id: 'plant', photoKey: 'key', photo: 'obsolete' };
  photoRequest.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ url: 'https://storage.invalid/signed', expiresIn: 600 });
  const { result } = renderHook(() => usePlantPhoto(plant));
  await waitFor(() => expect(result.current.failed).toBe(true));
  expect(result.current.src).toBeNull();
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.src).toBe('https://storage.invalid/signed'));
  expect(photoRequest).toHaveBeenCalledWith(mockUser, { action: 'read', plantId: 'plant' });
});

test('an image load error hides the failed image and retry gets a new URL', async () => {
  photoRequest.mockResolvedValueOnce({ url: 'expired', expiresIn: 600 })
    .mockResolvedValue({ url: 'renewed', expiresIn: 600 });
  const { result } = renderHook(() => usePlantPhoto({ id: 'plant', photoKey: 'key' }));
  await waitFor(() => expect(result.current.src).toBe('expired'));
  act(() => result.current.onError());
  expect(result.current.src).toBeNull();
  expect(result.current.failed).toBe(true);
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.src).toBe('renewed'));
  expect(result.current.failed).toBe(false);
  expect(photoRequest).toHaveBeenCalledTimes(2);
});

test('a failed URL renewal hides the old URL and automatically retries after 30 seconds', async () => {
  jest.useFakeTimers();
  try {
    photoRequest.mockResolvedValueOnce({ url: 'first', expiresIn: 600 })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ url: 'renewed', expiresIn: 600 });
    const { result, unmount } = renderHook(() => usePlantPhoto({ id: 'plant', photoKey: 'key' }));
    await act(async () => {});
    expect(result.current.src).toBe('first');
    await act(async () => jest.advanceTimersByTime(540000));
    expect(result.current.src).toBeNull();
    expect(result.current.failed).toBe(true);
    await act(async () => jest.advanceTimersByTime(29999));
    expect(photoRequest).toHaveBeenCalledTimes(2);
    await act(async () => jest.advanceTimersByTime(1));
    expect(result.current.src).toBe('renewed');
    expect(result.current.failed).toBe(false);
    unmount();
  } finally { jest.useRealTimers(); }
});

test('renews URLs before expiry and ignores a late response after photo replacement', async () => {
  jest.useFakeTimers();
  try {
    photoRequest.mockResolvedValue({ url: 'first', expiresIn: 600 });
    const { result, rerender, unmount } = renderHook((plant) => usePlantPhoto(plant), { initialProps: { id: 'plant', photoKey: 'key' } });
    await act(async () => {});
    expect(result.current.src).toBe('first');
    await act(async () => jest.advanceTimersByTime(540000));
    expect(photoRequest).toHaveBeenCalledTimes(2);
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
