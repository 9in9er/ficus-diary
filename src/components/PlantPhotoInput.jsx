import { useEffect, useId, useRef, useState } from 'react';
import PlantPhotoPreview from './PlantPhotoPreview';
import { isHttpPhotoUrl } from '../utils/photoUrl';

function FileDropzone({ id, onChange, onFileDrop, disabled }) {
  const fileInput = useRef(null);
  const dragDepth = useRef(0);
  const [isDragging, setIsDragging] = useState(false);
  const hasFiles = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');

  return <div className='photoFileDropzone'
    onDragEnter={(event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      dragDepth.current += 1;
      if (!disabled) setIsDragging(true);
    }}
    onDragOver={(event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
    }}
    onDragLeave={(event) => {
      event.preventDefault();
      event.stopPropagation();
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setIsDragging(false);
    }}
    onDrop={(event) => {
      event.preventDefault();
      event.stopPropagation();
      dragDepth.current = 0;
      setIsDragging(false);
      if (!disabled) onFileDrop(event.dataTransfer.files[0]);
    }}>
    <button type='button' className={`photoFileUpload${isDragging && !disabled ? ' photoFileUpload--dragging' : ''}`}
      disabled={disabled} onClick={() => fileInput.current?.click()}>
      <svg className='photoUploadIcon' width='28' height='28' viewBox='0 0 24 24' fill='none'
        stroke='currentColor' strokeWidth='1.5' strokeLinecap='round' strokeLinejoin='round' aria-hidden='true' focusable='false'>
        <rect x='3' y='3' width='18' height='18' rx='3' />
        <circle cx='8.5' cy='8.5' r='1.5' />
        <path d='m21 15-5-5L5 21' />
      </svg>
      <span className='photoDropTitle'>{isDragging && !disabled ? 'Отпустите изображение здесь' : 'Перетащите изображение сюда'}</span>
      <span className='photoHint'>или нажмите, чтобы выбрать файл</span>
    </button>
    <input ref={fileInput} id={`${id}-file`} className='fileLoad' type='file' accept='image/*'
      aria-label='Фотография растения' onChange={onChange} disabled={disabled} hidden />
  </div>;
}

function UrlPreview({ url, status, onStatusChange, className }) {
  const [previewUrl, setPreviewUrl] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setPreviewUrl('');
    onStatusChange(url, 'loading');
    const debounce = setTimeout(() => setPreviewUrl(url), 350);
    return () => clearTimeout(debounce);
  }, [url, attempt, onStatusChange]);

  useEffect(() => {
    if (status !== 'loading') return undefined;
    const timeout = setTimeout(() => onStatusChange(url, 'error'), 15000);
    return () => clearTimeout(timeout);
  }, [url, status, attempt, onStatusChange]);

  return <div className='photoUrlPreview'>
    {previewUrl === url && <img key={`${url}-${attempt}`} className={`plantPhotoPreview ${className}`.trim()}
      src={url} alt='Предпросмотр фотографии' hidden={status === 'error'}
      onLoad={() => onStatusChange(url, 'loaded')} onError={() => onStatusChange(url, 'error')} />}
    {status === 'loading' && <p className='photoHint' role='status'>Загружаем изображение…</p>}
    {status === 'error' && <div className='formError' role='alert'>
      <p>Не удалось загрузить изображение. Проверьте ссылку: сайт может запрещать показ изображения или оно недоступно.</p>
      <button className='btn photoRetry' type='button' onClick={() => setAttempt((value) => value + 1)}>Повторить</button>
    </div>}
  </div>;
}

export default function PlantPhotoInput({ form, disabled = false, previewClassName = '' }) {
  const { draft, handlePhotoChange, handlePhotoFile, setPhotoSource, setPhotoUrl, setPhotoUrlStatus } = form;
  const id = useId();
  const isUrl = draft.photoSource === 'url';
  const url = (draft.photoUrl || '').trim();
  const invalidUrl = !!url && !isHttpPhotoUrl(url);

  return <section className='plantPhotoInput' aria-label='Настройка фотографии растения'>
    <div id={`${id}-title`} className='photoTitle'>Фотография растения</div>
    <div className='photoSourceSwitch' role='group' aria-label='Способ добавления фотографии'>
      <button type='button' className='btn photoSourceButton' aria-pressed={!isUrl} disabled={disabled}
        onClick={() => !isUrl || setPhotoSource('file')}>Загрузить файл</button>
      <button type='button' className='btn photoSourceButton' aria-pressed={isUrl} disabled={disabled}
        onClick={() => isUrl || setPhotoSource('url')}>Вставить ссылку</button>
    </div>
    {isUrl ? <>
      <label className='photoUrlLabel' htmlFor={`${id}-url`}>Ссылка на изображение</label>
      <input id={`${id}-url`} className='input photoUrlInput' type='url' inputMode='url'
        value={draft.photoUrl} onChange={(event) => setPhotoUrl(event.target.value)}
        placeholder='https://example.com/plant' disabled={disabled} required
        aria-invalid={invalidUrl} aria-describedby={`${id}-hint${invalidUrl ? ` ${id}-error` : ''}`} />
      <p id={`${id}-hint`} className='photoHint'>Укажите прямую ссылку на изображение с http:// или https://, а не на страницу сайта.</p>
      {invalidUrl && <p id={`${id}-error`} className='formError' role='alert'>Введите корректную ссылку с http:// или https://.</p>}
      {isHttpPhotoUrl(url) && <UrlPreview url={url} status={draft.photoUrlStatus} onStatusChange={setPhotoUrlStatus} className={previewClassName} />}
    </> : <>
      <FileDropzone id={id} onChange={handlePhotoChange} onFileDrop={handlePhotoFile} disabled={disabled} />
      <PlantPhotoPreview plant={draft} className={previewClassName} />
    </>}
  </section>;
}
