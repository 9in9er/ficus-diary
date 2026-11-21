import { useId, useState } from 'react';
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
import dotsMenuIcon from '../i/icons/dots-menu.svg';
import closeIcon from '../i/icons/close.svg';
import '../styles/PlantCard.scss';

export default function WishlistCard({ plant, actions, editor, isTrash, isPending, runAction, onAcquired }) {
  const [editError, setEditError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isDotsMenuOpen, setIsDotsMenuOpen] = useState(false);
  const menuId = useId();
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
    <article className={`plantWrap wishlistCard ${isTrash ? 'plantWrap--trash' : ''}`} role='listitem' aria-label={plant.name} aria-busy={isPending}
      onMouseLeave={() => setIsDotsMenuOpen(false)} onKeyDown={(event) => {
        if (event.key === 'Escape' && isDotsMenuOpen) {
          setIsDotsMenuOpen(false);
          event.currentTarget.querySelector('.btnDotsMenu')?.focus();
        }
      }}>
      <div className='wishlistCardContent'>
        {editor.editingId === plant.id && !isTrash ? (
          <WishlistForm form={editor} onSubmit={submitEdit} onCancel={editor.cancelEdit} isSubmitting={isPending} error={editError} />
        ) : <div className='wishlistCardLayout'>
          <div className='wishlistCardHeader'>
            <h3 className='wishlistName'>{plant.name}</h3>
            <div className='wishlistCardActions'>
              {isTrash ? <>
                <button className='btn btnRestore' type='button' aria-label='Восстановить' title='Восстановить' disabled={isPending} onClick={() => runAction(() => actions.restorePlant(plant.id), 'Не удалось восстановить растение.')}><span><img src={recycleIcon} alt='' /></span></button>
                <button className='btn btnDelete' type='button' aria-label='Удалить навсегда' title='Удалить навсегда' disabled={isPending} onClick={() => setConfirmDelete(true)}><span><img src={trashIcon} alt='' /></span></button>
              </> : <>
                <button className='btn wishlistAcquire' type='button' disabled={isPending} onClick={async () => {
                  setIsDotsMenuOpen(false);
                  const acquired = await runAction(() => actions.acquireWish(plant.id), 'Не удалось перенести растение в коллекцию. Попробуйте ещё раз.');
                  if (acquired) onAcquired();
                }}><span><img src={checkIcon} alt='' /></span>Уже у меня</button>
                {isDotsMenuOpen && <div className='wishlistMoreActions' id={menuId} role='group' aria-label='Дополнительные действия'>
                  <button className='btn btnEdit' type='button' aria-label='Редактировать' title='Редактировать' disabled={isPending} onClick={() => {
                    setIsDotsMenuOpen(false);
                    setEditError('');
                    editor.startEdit(plant);
                  }}><span><img src={pencilIcon} alt='' /></span></button>
                  <button className='btn btnDelete' type='button' aria-label='Удалить' title='Удалить' disabled={isPending} onClick={() => {
                    setIsDotsMenuOpen(false);
                    runAction(() => actions.handleDeletePlant(plant.id), 'Не удалось переместить растение в корзину.');
                  }}><span><img src={trashIcon} alt='' /></span></button>
                </div>}
                <button className='btn btnDotsMenu' type='button' aria-label='Действия с растением' title='Действия с растением'
                  aria-expanded={isDotsMenuOpen} aria-controls={isDotsMenuOpen ? menuId : undefined} disabled={isPending}
                  onClick={() => setIsDotsMenuOpen((value) => !value)}>
                  <span><img src={isDotsMenuOpen ? closeIcon : dotsMenuIcon} alt='' /></span>
                </button>
              </>}
            </div>
          </div>
          <div className='wishlistCardMedia'>
            <PlantPhoto plant={plant} className='wishlistPhoto' />
          </div>
          <div className='wishlistCardInfo'>
            <WishlistDetails plant={plant} />
            {isTrash && <p className='wishlistHint'>Удалено: {formatDate(plant.deletedAt)}. Хранится в корзине до удаления вручную.</p>}
          </div>
        </div>}
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
