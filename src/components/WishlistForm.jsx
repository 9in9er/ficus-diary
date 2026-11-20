import { useId } from 'react';
import PlantPhotoInput from './PlantPhotoInput';
import '../styles/PlantForm.scss';
import '../styles/Wishlist.scss';

export default function WishlistForm({ form, onSubmit, onCancel, isSubmitting, error }) {
  const { draft, setField, isProcessingPhoto, photoError, isPhotoReady } = form;
  const linksHintId = useId();
  return (
    <form className='mainForm wishlistForm' aria-label='Данные растения в вишлисте' onSubmit={(event) => {
      if (!isPhotoReady) { event.preventDefault(); return; }
      onSubmit(event);
    }} aria-busy={isSubmitting}>
      <fieldset disabled={isSubmitting}>
        <label>Название растения<input className='input' value={draft.name} onChange={(event) => setField('name', event.target.value)} placeholder='Например, алоказия фрайдек' required /></label>
        <PlantPhotoInput form={form} disabled={isSubmitting} previewClassName='wishlistPhotoPreview' />
        <label>Описание<textarea className='input' rows={3} value={draft.description} onChange={(event) => setField('description', event.target.value)} placeholder='Сорт, размер или другие пожелания' /></label>
        <label>Примерная цена<input className='input' value={draft.price} onChange={(event) => setField('price', event.target.value)} placeholder='Например, 1 500–2 000 ₽' /></label>
        <label>Ссылки<textarea className='input' rows={3} value={draft.links} onChange={(event) => setField('links', event.target.value)} placeholder='https://example.com/plant' aria-describedby={linksHintId} /></label>
        <p id={linksHintId} className='wishlistHint'>Каждая ссылка с новой строки. Все поля, кроме названия, необязательные.</p>
      </fieldset>
      {(error || photoError) && <p className='formError' role='alert'>{error || photoError}</p>}
      <div className='modalButtons'>
        <button className='btn btnSubmit' type='submit' disabled={isSubmitting || isProcessingPhoto || !isPhotoReady}>{isSubmitting ? 'Сохраняем…' : isProcessingPhoto ? 'Обрабатываем фото…' : 'Сохранить'}</button>
        <button className='btn btnCancel' type='button' onClick={onCancel} disabled={isSubmitting}>Отмена</button>
      </div>
    </form>
  );
}
