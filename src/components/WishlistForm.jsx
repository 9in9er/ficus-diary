import { useEffect, useId, useState } from 'react';
import PlantPhoto from './PlantPhoto';
import '../styles/PlantForm.scss';
import '../styles/Wishlist.scss';

export default function WishlistForm({ form, onSubmit, onCancel, isSubmitting, error }) {
  const { draft, setField, handlePhotoChange, isProcessingPhoto, photoError } = form;
  const linksHintId = useId();
  const [localPreview, setLocalPreview] = useState(null);
  useEffect(() => {
    if (!draft.photoBlob) { setLocalPreview(null); return undefined; }
    const url = URL.createObjectURL(draft.photoBlob);
    setLocalPreview({ blob: draft.photoBlob, url });
    return () => URL.revokeObjectURL(url);
  }, [draft.photoBlob]);
  const localSrc = localPreview && localPreview.blob === draft.photoBlob ? localPreview.url : null;
  return (
    <form className='mainForm wishlistForm' aria-label='Данные растения в вишлисте' onSubmit={onSubmit} aria-busy={isSubmitting}>
      <fieldset disabled={isSubmitting}>
        <label>Название растения<input className='input' value={draft.name} onChange={(event) => setField('name', event.target.value)} placeholder='Например, алоказия фрайдек' required /></label>
        <label>Фотография растения<input className='fileLoad' type='file' accept='image/*' onChange={handlePhotoChange} /></label>
        {draft.photoBlob ? (
          localSrc && <img className='wishlistPhotoPreview' src={localSrc} alt='Предпросмотр фотографии' />
        ) : <PlantPhoto plant={draft} className='wishlistPhotoPreview' alt='Предпросмотр фотографии' />}
        <label>Описание<textarea className='input' rows={3} value={draft.description} onChange={(event) => setField('description', event.target.value)} placeholder='Сорт, размер или другие пожелания' /></label>
        <label>Примерная цена<input className='input' value={draft.price} onChange={(event) => setField('price', event.target.value)} placeholder='Например, 1 500–2 000 ₽' /></label>
        <label>Ссылки<textarea className='input' rows={3} value={draft.links} onChange={(event) => setField('links', event.target.value)} placeholder='https://example.com/plant' aria-describedby={linksHintId} /></label>
        <p id={linksHintId} className='wishlistHint'>Каждая ссылка с новой строки. Все поля, кроме названия, необязательные.</p>
      </fieldset>
      {(error || photoError) && <p className='formError' role='alert'>{error || photoError}</p>}
      <div className='modalButtons'>
        <button className='btn btnSubmit' type='submit' disabled={isSubmitting || isProcessingPhoto}>{isSubmitting ? 'Сохраняем…' : isProcessingPhoto ? 'Обрабатываем фото…' : 'Сохранить'}</button>
        <button className='btn btnCancel' type='button' onClick={onCancel} disabled={isSubmitting}>Отмена</button>
      </div>
    </form>
  );
}
