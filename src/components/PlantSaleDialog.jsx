import { useRef, useState } from 'react';
import ModalDialog from './ModalDialog';
import PlantPhoto from './PlantPhoto';
import { getLocalDate } from '../utils/plantDates';
import { purchasePriceText, saleFields } from '../utils/plantSales';
import '../styles/PlantSales.scss';

export default function PlantSaleDialog({ plant, onSave, onClose }) {
  const [salePrice, setSalePrice] = useState('');
  const [soldAt, setSoldAt] = useState(getLocalDate);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const submit = async (event) => {
    event.preventDefault();
    if (saving.current) return;
    let fields;
    try { fields = saleFields({ salePrice, soldAt }); }
    catch (validationError) { setError(validationError.message); return; }
    saving.current = true;
    setBusy(true);
    setError('');
    try {
      const saved = await onSave(fields);
      if (saved) onClose();
      else setError('Не удалось сохранить продажу. Попробуйте ещё раз.');
    } catch (saveError) {
      if (saveError.code === 'permission-denied') {
        setError('Не удалось сохранить продажу: сервер отклонил доступ (permission-denied). Необходимо проверить правила доступа приложения.');
      } else if (saveError.code === 'unauthenticated') {
        setError('Сессия истекла. Войдите в аккаунт заново и повторите сохранение.');
      } else {
        setError('Не удалось сохранить продажу. Попробуйте ещё раз.');
      }
    } finally { saving.current = false; setBusy(false); }
  };
  return <ModalDialog labelledBy='plantSaleTitle' describedBy='plantSaleHint' isBusy={busy} onClose={onClose} className='plantSaleDialog'>
    <h2 id='plantSaleTitle'>Продажа растения</h2>
    <div className='salePlantPreview'>
      <PlantPhoto plant={plant} className='plantPhoto' />
      <div><strong>{plant.name}</strong><p className='purchasePrice'>Цена покупки: {purchasePriceText(plant.price)}</p></div>
    </div>
    <form onSubmit={submit} aria-busy={busy}>
      <label className='moneyLabel'>Цена продажи, ₽
        <input className='input' type='number' min='0' max='1000000000000' step='0.01' required value={salePrice}
          disabled={busy} onChange={(event) => setSalePrice(event.target.value)} />
      </label>
      <label className='moneyLabel'>Дата продажи
        <input className='plantDate' type='date' required value={soldAt} disabled={busy} onChange={(event) => setSoldAt(event.target.value)} />
      </label>
      <p id='plantSaleHint' className='saleHint'>Растение будет перемещено в раздел „Проданные“. Все заметки и история ухода сохранятся</p>
      {error && <p role='alert' className='formError'>{error}</p>}
      <div className='modalButtons'>
        <button className='btn btnCancel' type='button' onClick={onClose} disabled={busy}>Отмена</button>
        <button className='btn btnSubmit' type='submit' disabled={busy}>{busy ? 'Сохраняем…' : 'Отметить проданным'}</button>
      </div>
    </form>
  </ModalDialog>;
}
