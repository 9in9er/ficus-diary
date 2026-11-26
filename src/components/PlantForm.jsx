import PlantPhotoInput from './PlantPhotoInput';
import '../styles/PlantForm.scss';

function PlantForm({
  name,
  acquiredAt,
  photoForm,
  onNameChange,
  onDateChange,
  onSubmit,
  onCancel,
  isSubmitting = false,
  isProcessingPhoto = false,
  error = '',
}) {
  return (
    <form className='mainForm' onSubmit={(event) => {
      if (!photoForm.isPhotoReady) { event.preventDefault(); return; }
      onSubmit(event);
    }} aria-label='Данные растения' aria-busy={isSubmitting}>
      <div className='mainForm_wrap'>
        <div className='nameAndDate'>
          <label className='nameLabel'>
            Название растения
            <input
              className='input inputPlantName'
              type='text'
              placeholder='напр. алоказия фрайдек'
              value={name}
              onChange={(e) => onNameChange(e.target.value)}
              required
              disabled={isSubmitting}
            />
          </label>
          <label className='dateLabel'>
            Дата появления
            <input
              className='plantDate'
              type='date'
              value={acquiredAt}
              onChange={(e) => onDateChange(e.target.value)}
              disabled={isSubmitting}
            />
          </label>
        </div>
      </div>

      <label className='moneyLabel'>
        Цена покупки, ₽
        <input className='input' type='number' min='0' max='1000000000000' step='0.01'
          value={photoForm.draft.price ?? ''} disabled={isSubmitting}
          onChange={(event) => photoForm.setField('price', event.target.value)} />
      </label>
      {photoForm.draft.hasSale && <div className='saleFields'>
        <label className='moneyLabel'>Цена продажи, ₽
          <input className='input' type='number' min='0' max='1000000000000' step='0.01' required
            value={photoForm.draft.salePrice ?? ''} disabled={isSubmitting}
            onChange={(event) => photoForm.setField('salePrice', event.target.value)} />
        </label>
        <label className='moneyLabel'>Дата продажи
          <input className='plantDate' type='date' required value={photoForm.draft.soldAt} disabled={isSubmitting}
            onChange={(event) => photoForm.setField('soldAt', event.target.value)} />
        </label>
      </div>}

      <PlantPhotoInput form={photoForm} disabled={isSubmitting} />
      {error && <p className='formError' role='alert'>{error}</p>}
      <div className='modalButtons'>
        <button className='btn btnSubmit' type='submit' disabled={isSubmitting || isProcessingPhoto || !photoForm.isPhotoReady}>
          {isSubmitting ? 'Сохраняем…' : isProcessingPhoto ? 'Обрабатываем фото…' : 'Сохранить'}
        </button>
        <button
          className='btn btnCancel'
          type='button'
          onClick={onCancel}
          disabled={isSubmitting}
        >
          Отмена
        </button>
      </div>
    </form>
  );
}

export default PlantForm;
