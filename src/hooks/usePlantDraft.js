import { useRef, useState } from 'react';
import { resizePlantPhoto } from '../utils/resizePlantPhoto';

const emptyDraft = () => ({ name: '', acquiredAt: '', photo: null });

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
      name: plant.name,
      acquiredAt: plant.acquiredAt || '',
      photo: plant.photo || null,
    } : emptyDraft());
  };

  const setField = (field, value) => {
    setDraft((previous) => ({ ...previous, [field]: value }));
  };

  const handlePhotoChange = async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const request = ++photoRequest.current;
    setPhotoError('');
    setIsProcessingPhoto(true);
    try {
      const photo = await resizePlantPhoto(file);
      if (request === photoRequest.current) setField('photo', photo);
    } catch {
      if (request === photoRequest.current) {
        setPhotoError('Не удалось обработать фото. Выберите другое изображение.');
      }
    } finally {
      if (request === photoRequest.current) setIsProcessingPhoto(false);
    }
  };

  return { draft, setField, resetDraft, handlePhotoChange, isProcessingPhoto, photoError };
}
