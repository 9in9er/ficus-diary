import { useState } from 'react';
import { formatDate } from '../utils/plantDates';
import WishlistDetails from './WishlistDetails';
import PlantPhoto from './PlantPhoto';
import WishlistForm from './WishlistForm';
import ModalDialog from './ModalDialog';
import { getWishlistDetails } from '../utils/wishlist';
import pencilIcon from '../i/icons/pencil.svg';
import trashIcon from '../i/icons/trash.svg';
import recycleIcon from '../i/icons/recycle.svg';
import checkIcon from '../i/icons/check.svg';
import '../styles/PlantCard.scss';

export default function WishlistCard({ plant, actions, editor, isTrash, isPending, runAction, onAcquired }) {
  const [editError, setEditError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const submitEdit = async (event) => {
    event.preventDefault();
    if (isPending || editor.isProcessingPhoto) return;
    if (!editor.draft.name.trim()) { setEditError('Введите название растения.'); return; }
    setEditError('');
    try {
      getWishlistDetails(editor.draft);
    } catch (error) {
      setEditError(error.message);
      return;
    }
    const saved = await runAction(() => actions.saveWish(plant.id, editor.draft), 'Не удалось сохранить изменения. Попробуйте ещё раз.');
    if (saved) editor.cancelEdit();
  };
  return (
    <article className={`plantWrap wishlistCard ${isTrash ? 'plantWrap--trash' : ''}`} role='listitem' aria-label={plant.name} aria-busy={isPending}>
      <div className='wishlistCardContent'>
        {editor.editingId === plant.id && !isTrash ? (
          <WishlistForm form={editor} onSubmit={submitEdit} onCancel={editor.cancelEdit} isSubmitting={isPending} error={editError} />
        ) : <>
          <div className='wishlistCardActions'>
            {isTrash ? <>
              <button className='btn btnRestore' type='button' aria-label='Восстановить' title='Восстановить' disabled={isPending} onClick={() => runAction(() => actions.restorePlant(plant.id), 'Не удалось восстановить растение.')}><span><img src={recycleIcon} alt='' /></span></button>
              <button className='btn btnDelete' type='button' aria-label='Удалить навсегда' title='Удалить навсегда' disabled={isPending} onClick={() => setConfirmDelete(true)}><span><img src={trashIcon} alt='' /></span></button>
            </> : <>
              <button className='btn wishlistAcquire' type='button' disabled={isPending} onClick={async () => {
                const acquired = await runAction(() => actions.acquireWish(plant.id), 'Не удалось перенести растение в коллекцию. Попробуйте ещё раз.');
                if (acquired) onAcquired();
              }}><span><img src={checkIcon} alt='' /></span>Уже у меня</button>
              <button className='btn btnEdit' type='button' aria-label='Редактировать' title='Редактировать' disabled={isPending} onClick={() => { setEditError(''); editor.startEdit(plant); }}><span><img src={pencilIcon} alt='' /></span></button>
              <button className='btn btnDelete' type='button' aria-label='Удалить' title='Удалить' disabled={isPending} onClick={() => runAction(() => actions.handleDeletePlant(plant.id), 'Не удалось переместить растение в корзину.')}><span><img src={trashIcon} alt='' /></span></button>
            </>}
          </div>
          <h3 className='wishlistName'>{plant.name}</h3>
          <PlantPhoto plant={plant} className='wishlistPhoto' />
          <WishlistDetails plant={plant} />
          {isTrash && <p className='wishlistHint'>Удалено: {formatDate(plant.deletedAt)}. Автоматическое удаление отключено.</p>}
        </>}
      </div>
      {confirmDelete && <ModalDialog labelledBy={`deleteWish-${plant.id}`} onClose={() => setConfirmDelete(false)} isBusy={isPending}>
        <h2 id={`deleteWish-${plant.id}`}>Удалить «{plant.name}» навсегда?</h2>
        <p>Восстановить эту запись уже не получится.</p>
        <div className='modalButtons'>
          <button className='btn btnSubmit' disabled={isPending} onClick={() => setConfirmDelete(false)}>Отмена</button>
          <button className='btn btnCancel' disabled={isPending} onClick={async () => {
            const removed = await runAction(() => actions.permanentlyDeletePlant(plant.id), 'Не удалось удалить растение навсегда.');
            if (removed) setConfirmDelete(false);
          }}>Удалить навсегда</button>
        </div>
      </ModalDialog>}
    </article>
  );
}
