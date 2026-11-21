import { useEffect, useState } from 'react';
import PlantPhoto from './PlantPhoto';

export default function PlantPhotoPreview({ plant, className = '' }) {
  const [localPreview, setLocalPreview] = useState(null);

  useEffect(() => {
    if (!plant.photoBlob) { setLocalPreview(null); return undefined; }
    const url = URL.createObjectURL(plant.photoBlob);
    setLocalPreview({ blob: plant.photoBlob, url });
    return () => URL.revokeObjectURL(url);
  }, [plant.photoBlob]);

  const localSrc = localPreview && localPreview.blob === plant.photoBlob ? localPreview.url : null;
  const previewClassName = `plantPhotoPreview ${className}`.trim();

  return plant.photoBlob ? (
    localSrc && <img className={previewClassName} src={localSrc} alt='Предпросмотр фотографии' />
  ) : <PlantPhoto plant={plant} className={previewClassName} alt='Предпросмотр фотографии' lazy={false} variant='original' />;
}
