import '../styles/PlantForm.scss';

function PlantForm({
  name,
  acquiredAt,
  onNameChange,
  onDateChange,
  onPhotoChange,
  onSubmit,
  onCancel,
  isSubmitting = false,
  isProcessingPhoto = false,
  error = '',
}) {
  return (
    <form className='mainForm' onSubmit={onSubmit} aria-label='Данные растения' aria-busy={isSubmitting}>
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
        <input
          className='fileLoad'
          type='file'
          accept='image/*'
          aria-label='Фотография растения'
          onChange={onPhotoChange}
          disabled={isSubmitting}
        />
      </div>

      {error && <p className='formError' role='alert'>{error}</p>}
      <div className='modalButtons'>
        <button className='btn btnSubmit' type='submit' disabled={isSubmitting || isProcessingPhoto}>
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
