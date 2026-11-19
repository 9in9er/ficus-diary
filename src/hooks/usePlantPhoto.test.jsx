import { act, renderHook, waitFor } from '@testing-library/react';
import usePlantPhoto from './usePlantPhoto';
import { photoRequest } from '../services/plantPhotos';

const mockUser = { uid: 'owner' };
jest.mock('./useAuth', () => ({ useAuth: () => ({ user: mockUser }) }));
jest.mock('../services/plantPhotos', () => ({ photoRequest: jest.fn() }));

beforeEach(() => { jest.clearAllMocks(); });

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
