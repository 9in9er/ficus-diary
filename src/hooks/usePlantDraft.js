import { useRef, useState } from 'react';
import { resizePlantPhoto } from '../utils/resizePlantPhoto';

const emptyDraft = () => ({ id: null, name: '', acquiredAt: '', photoKey: null, photo: null, photoBlob: null, description: '', price: '', links: '' });

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
      description: plant.description || '',
      price: plant.price || '',
      links: Array.isArray(plant.links) ? plant.links.join('\n') : '',
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

  return { draft, setField, resetDraft, handlePhotoChange, isProcessingPhoto, photoError };
}
