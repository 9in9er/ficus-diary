import { act, renderHook } from '@testing-library/react';
import usePlantDraft from './usePlantDraft';

test('new and reset drafts omit the obsolete photo field', () => {
  const { result } = renderHook(() => usePlantDraft());
  expect(result.current.draft).not.toHaveProperty('photo');
  expect(result.current.draft).toMatchObject({ photoKey: null, photoBlob: null });
  act(() => result.current.resetDraft({ id: 'plant', name: 'Ficus', photoKey: 'stored-key' }));
  act(() => result.current.resetDraft());
  expect(result.current.draft).not.toHaveProperty('photo');
  expect(result.current.draft).toMatchObject({ id: null, photoKey: null, photoBlob: null });
});

test.each(['stored-key', undefined])('editing with photoKey %s copies only current photo fields', (photoKey) => {
  const { result } = renderHook(() => usePlantDraft());
  act(() => result.current.resetDraft({ id: 'plant', name: 'Ficus', photoKey, photo: 'obsolete' }));
  expect(result.current.draft).not.toHaveProperty('photo');
  expect(result.current.draft).toMatchObject({ id: 'plant', name: 'Ficus', photoKey: photoKey || null, photoBlob: null });
});
