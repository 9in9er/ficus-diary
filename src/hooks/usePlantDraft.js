import { useCallback, useRef, useState } from 'react';
import { resizePlantPhoto } from '../utils/resizePlantPhoto';
import { isHttpPhotoUrl } from '../utils/photoUrl';

const emptyDraft = () => ({ id: null, name: '', acquiredAt: '', photoKey: null, photo: null, photoBlob: null, photoSource: 'file', photoUrl: '', photoUrlStatus: 'loading', description: '', price: '', links: '' });

export default function usePlantDraft() {
  const [draft, setDraft] = useState(emptyDraft);
  const [isProcessingPhoto, setIsProcessingPhoto] = useState(false);
  const [photoError, setPhotoError] = useState('');
  const photoRequest = useRef(0);

  const resetDraft = (plant) => {
    photoRequest.current += 1;
    setIsProcessingPhoto(false);
    setPhotoError('');
    setDraft(plant ? {
      id: plant.id,
      name: plant.name,
      acquiredAt: plant.acquiredAt || '',
      photoKey: plant.photoKey || null,
      photo: plant.photo || null,
      photoBlob: null,
      photoSource: !plant.photoKey && isHttpPhotoUrl(plant.photo) ? 'url' : 'file',
      photoUrl: !plant.photoKey && isHttpPhotoUrl(plant.photo) ? plant.photo : '',
      photoUrlStatus: 'loading',
      description: plant.description || '',
      price: plant.price || '',
      links: Array.isArray(plant.links) ? plant.links.join('\n') : '',
    } : emptyDraft());
  };

  const setField = (field, value) => {
    setDraft((previous) => ({ ...previous, [field]: value }));
  };

  const setPhotoSource = (photoSource) => {
    photoRequest.current += 1;
    setIsProcessingPhoto(false);
    setPhotoError('');
    setDraft((previous) => ({ ...previous, photoSource, photoBlob: null, photoUrlStatus: 'loading' }));
  };

  const setPhotoUrl = (photoUrl) => {
    setDraft((previous) => ({ ...previous, photoUrl, photoUrlStatus: 'loading' }));
  };

  const setPhotoUrlStatus = useCallback((url, status) => {
    setDraft((previous) => previous.photoSource === 'url' && previous.photoUrl.trim() === url
      ? { ...previous, photoUrlStatus: status } : previous);
  }, []);

  const handlePhotoFile = async (file) => {
    if (!file) return;
    const request = ++photoRequest.current;
    setPhotoError('');
    setIsProcessingPhoto(true);
    try {
      const photoBlob = await resizePlantPhoto(file);
      if (request === photoRequest.current) setField('photoBlob', photoBlob);
    } catch {
      if (request === photoRequest.current) {
        setPhotoError('Не удалось обработать фото. Выберите другое изображение.');
      }
    } finally {
      if (request === photoRequest.current) setIsProcessingPhoto(false);
    }
  };

  const handlePhotoChange = (event) => {
    const file = event.target.files[0];
    event.target.value = '';
    return handlePhotoFile(file);
  };

  const isPhotoReady = draft.photoSource !== 'url'
    || (isHttpPhotoUrl(draft.photoUrl) && draft.photoUrlStatus === 'loaded');

  return { draft, setField, resetDraft, handlePhotoChange, handlePhotoFile, isProcessingPhoto, photoError,
    setPhotoSource, setPhotoUrl, setPhotoUrlStatus, isPhotoReady };
}
