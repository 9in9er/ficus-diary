import { act, renderHook } from '@testing-library/react';
import usePlantDraft from './usePlantDraft';

test('editing external photos restores the URL mode without reintroducing an obsolete draft photo field', () => {
  const { result } = renderHook(() => usePlantDraft());
  const photo = 'https://example.com/image?id=123';
  act(() => result.current.resetDraft({ id: 'plant', name: 'Ficus', photo }));
  expect(result.current.draft).toMatchObject({ photoSource: 'url', photoUrl: photo });
  expect(result.current.draft).not.toHaveProperty('photo');
  act(() => result.current.resetDraft({ id: 'plant', name: 'Ficus', photo, photoKey: 'replacement-file' }));
  expect(result.current.draft).toMatchObject({ photoSource: 'file', photoUrl: '', photoKey: 'replacement-file' });
});

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
