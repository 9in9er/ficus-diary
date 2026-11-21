import { useEffect, useId, useRef, useState } from 'react';
import usePlantPhoto from '../hooks/usePlantPhoto';
import { isHttpPhotoUrl } from '../utils/photoUrl';
import ModalDialog from './ModalDialog';
import '../styles/PlantPhoto.scss';

export default function PlantPhoto({ plant, className, alt = plant.name, lazy = true, variant = 'thumbnail', zoomable = lazy }) {
  const imageRef = useRef(null);
  const [nearViewport, setNearViewport] = useState(() => !lazy || typeof IntersectionObserver === 'undefined');
  const enabled = !lazy || nearViewport;
  const hasPhoto = !!(plant.photoKey || plant.photo);
  const photoIdentity = (variant === 'thumbnail' && plant.photoThumbKey) || plant.photoKey || plant.photo;
  const originalIdentity = plant.photoKey || plant.photo;
  const [expandedPhoto, setExpandedPhoto] = useState(null);
  const titleId = useId();
  useEffect(() => {
    if (enabled || !hasPhoto || !imageRef.current) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setNearViewport(true);
        observer.disconnect();
      }
    }, { rootMargin: '300px' });
    observer.observe(imageRef.current.closest('[role="listitem"]') || imageRef.current);
    return () => observer.disconnect();
  }, [enabled, hasPhoto, photoIdentity]);
  const { src, failed, retry, onError, revision } = usePlantPhoto(plant, enabled, variant);
  const isExternal = !plant.photoKey && isHttpPhotoUrl(plant.photo);
  const image = hasPhoto && (!failed || plant.photoKey) && <img ref={imageRef}
    key={`${photoIdentity}-${revision}`} className={className}
    src={src || undefined} alt={src ? alt : ''} aria-hidden={!src || undefined}
    decoding='async' width={lazy ? 150 : undefined} height={lazy ? 188 : undefined}
    style={{ visibility: src ? undefined : 'hidden', ...(lazy ? { aspectRatio: '4 / 5', height: 'auto' } : {}) }}
    onError={onError} />;
  return <>
    {image && (zoomable ? <button type='button' className='plantPhotoButton' disabled={!src || failed}
      aria-label={`Увеличить фото: ${alt}`} onClick={() => setExpandedPhoto(originalIdentity)}>{image}</button> : image)}
    {failed && <span className='formError' role='status'>Не удалось загрузить фото. {isExternal && 'Изображение недоступно или сайт запрещает его показ. '}<button type='button' className='btn' onClick={retry}>Повторить</button></span>}
    {hasPhoto && zoomable && expandedPhoto === originalIdentity && <ModalDialog labelledBy={titleId}
      className='plantPhotoDialog' onClose={() => setExpandedPhoto(null)}>
      <h2 id={titleId}>{alt}</h2>
      <button type='button' className='btn' onClick={() => setExpandedPhoto(null)}>Закрыть</button>
      <PlantPhoto plant={plant} className='plantPhotoFull' alt={alt} lazy={false} variant='original' zoomable={false} />
    </ModalDialog>}
  </>;
}
