import { useState } from 'react';
import useAutoResizeTextarea from '../hooks/useAutoResizeTextarea';
import { formatDate } from '../utils/plantDates';
import PlantCareHistory from './PlantCareHistory';
import '../styles/PlantCard.scss';

import iconEmojiDroplet from '../i/icons/droplet.svg';
import iconEmojiTestTube from '../i/icons/flask-conical.svg';
import iconEmojiPencil from '../i/icons/pencil.svg';
import iconEmojiPushpin from '../i/icons/pin.svg';
import iconEmojiEye from '../i/icons/eye.svg';
import iconEmojiEyeOff from '../i/icons/eye-off.svg';
import iconEmojiWastebasket from '../i/icons/trash.svg';
import recycleIcon from '../i/icons/recycle.svg';
import iconEmojiShovel from '../i/icons/shovel.svg';

import dotsMenuIcon from '../i/icons/dots-menu.svg';
import closeIcon from '../i/icons/close.svg';

import PlantForm from './PlantForm';
import PlantPhoto from './PlantPhoto';
import CardSavingOverlay from './CardSavingOverlay';
import PlantName from './PlantName';

function PlantCard({ plant, actions, editor, noteText, onNoteTextChange, isTrash = false, isPending, runAction }) {
  const {
    handleWaterPlant, handleFertilizePlant, deleteWateringEntry, deleteFertilizingEntry,
    handleDeletePlant, toggleNeedReplant, togglePinPlant, toggleHidePlant,
    addNoteToPlant, deleteNoteFromPlant, restorePlant, permanentlyDeletePlant,
  } = actions;
  const { editingId, draft: editPlant, startEdit: startEditPlant, cancelEdit } = editor;
  const [isDotsMenuOpen, setIsDotsMenuOpen] = useState(false);
  const [editError, setEditError] = useState('');
  const isEditing = editingId === plant.id;
  const noteInputRef = useAutoResizeTextarea(noteText, isEditing, isTrash);

  const notes = plant.notes || [];
  const sortedNotes = [...notes].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );
  const latestNotes = sortedNotes.slice(0, 3);
  const olderNotes = sortedNotes.slice(3);
  const wateringLog = Array.isArray(plant.wateringLog) ? plant.wateringLog : [];
  const fertilizingLog = Array.isArray(plant.fertilizingLog) ? plant.fertilizingLog : [];
  const needReplant = !!plant.replanted;
  const isPinned = !!plant.pinned;
  const isHidden = !!plant.hidden;

  const submitNote = async () => {
    if (isPending || !noteText.trim()) return;
    const saved = await runAction(
      () => addNoteToPlant(plant.id, notes, noteText),
      'Не удалось сохранить заметку. Попробуйте ещё раз.'
    );
    if (saved) onNoteTextChange('');
  };

  const submitEdit = async (event) => {
    event.preventDefault();
    if (isPending || editor.isProcessingPhoto) return;
    if (!editPlant.name.trim()) {
      setEditError('Введите название растения.');
      return;
    }
    setEditError('');
    const saved = await runAction(
      () => actions.savePlant(plant.id, editPlant),
      'Не удалось сохранить изменения. Попробуйте ещё раз.'
    );
    if (saved) cancelEdit();
  };

  const renderNoteItem = (note) => (
    <li key={note.id} className='notesItem'>
      <div>
        <div className='notesText'>{note.text}</div>
        <div className='notesDate'>
          {formatDate(note.createdAt)}{' '}
          {new Date(note.createdAt).toLocaleTimeString('ru-RU', {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </div>
      </div>
      {!isTrash && (
        <button
          className='btn btnDelete'
          type='button'
          disabled={isPending}
          onClick={() => runAction(
            () => deleteNoteFromPlant(plant.id, notes, note.id),
            'Не удалось удалить заметку. Попробуйте ещё раз.'
          )}
        >
          ✖
        </button>
      )}
    </li>
  );

  return (
    <div
      role='listitem'
      aria-label={plant.name}
      aria-busy={isPending}
      className={`plantWrap ${isPinned ? 'plantWrap--pinned' : ''} ${isTrash ? "plantWrap--trash" : ""}`}
      onMouseLeave={() => setIsDotsMenuOpen(false)}
    >
      {isPending && <CardSavingOverlay />}
      <div className='plantInfo'>
        {isEditing ? (
          <PlantForm
            photoForm={editor}
            name={editPlant.name}
            acquiredAt={editPlant.acquiredAt}
            onNameChange={(newName) =>
              editor.setField('name', newName)
            }
            onDateChange={(newDate) =>
              editor.setField('acquiredAt', newDate)
            }
            onSubmit={submitEdit}
            onCancel={() => { setEditError(''); cancelEdit(); }}
            isSubmitting={isPending}
            error={editError || editor.photoError}
            isProcessingPhoto={editor.isProcessingPhoto}
          />
        ) : (
          <>
            <div className='aboutPlant'>
              <div className={`badge badge--replant ${needReplant ? 'badge--active' : ''}`}><img src={iconEmojiShovel} alt='iconEmojiShovel'/></div>
              <PlantName name={plant.name} />
              <div className="aboutPlantWrap">
                <div className='photoInfo'>
                  <PlantPhoto plant={plant} className='plantPhoto' />

                  <PlantCareHistory
                    plantId={plant.id}
                    log={wateringLog}
                    title='Последний полив'
                    emptyMessage='ещё не поливали'
                    className='aboutWatering'
                    listClassName='wateringList'
                    isTrash={isTrash}
                    isPending={isPending}
                    onDelete={(id, log, date) => runAction(
                      () => deleteWateringEntry(id, log, date),
                      'Не удалось удалить запись полива. Попробуйте ещё раз.'
                    )}
                  />
                  <PlantCareHistory
                    plantId={plant.id}
                    log={fertilizingLog}
                    title='Последнее удобрение'
                    emptyMessage='ещё не удобряли'
                    className='aboutFertilizing'
                    listClassName='fertilizingList'
                    isTrash={isTrash}
                    isPending={isPending}
                    onDelete={(id, log, date) => runAction(
                      () => deleteFertilizingEntry(id, log, date),
                      'Не удалось удалить запись удобрения. Попробуйте ещё раз.'
                    )}
                  />
                </div>
                <div className='textInfos'>
                  <p className='dateOfAppearance'>
                    <strong>Дата появления: </strong>
                    {plant.acquiredAt ? formatDate(plant.acquiredAt) : 'неизвестно'}
                  </p>

                  <div className='notesBlock'>
                    {!isTrash && (
                      <div className='notesAdd'>
                        <textarea
                          ref={noteInputRef}
                          className='input notesInput'
                          rows={1}
                          aria-label='Новая заметка'
                          placeholder='Новая заметка...'
                          value={noteText}
                          disabled={isPending}
                          onChange={(e) => onNoteTextChange(e.target.value)}
                        />
                        <button
                          className='btn btnSubmit'
                          type='button'
                          onClick={submitNote}
                          disabled={isPending}
                          aria-label='Сохранить заметку'
                        >
                          ↩
                        </button>
                      </div>
                    )}

                    {sortedNotes.length === 0 && (
                      <p className='notesEmpty'>Пока нет заметок.</p>
                    )}

                    {sortedNotes.length > 0 && (
                      <>
                        <ul className='notesList'>
                          {latestNotes.map(renderNoteItem)}
                        </ul>
                        {olderNotes.length > 0 && (
                          <details className='notesMore'>
                            <summary>
                              Показать все заметки ({sortedNotes.length - 3})
                            </summary>
                            <ul className='notesList'>
                              {olderNotes.map(renderNoteItem)}
                            </ul>
                          </details>
                        )}
                      </>
                    )}
                  </div>

                  {isTrash && (
                    <div className="trashInfo">
                        <p>
                            Удалено:{' '}
                            {formatDate(plant.deletedAt)}
                        </p>

                        <p>Хранится в корзине до удаления вручную.</p>

                    </div>
                  )}
                </div>
              </div>
              
              {!isTrash && (
                <div className='btnsWrap cardBtns'>
                  <button
                    className='btn btnWatering'
                    disabled={isPending}
                    onClick={() => runAction(
                      () => handleWaterPlant(plant.id, wateringLog),
                      'Не удалось сохранить полив. Попробуйте ещё раз.'
                    )}
                  >
                    <span>
                      <img src={iconEmojiDroplet} alt='iconEmojiDroplet'/>
                    </span>
                  </button>
                  <button
                    className='btn btnFertilizing'
                    disabled={isPending}
                    onClick={() => runAction(
                      () => handleFertilizePlant(plant.id, fertilizingLog),
                      'Не удалось сохранить удобрение. Попробуйте ещё раз.'
                    )}
                  >
                    <span>
                      <img src={iconEmojiTestTube} alt='iconEmojiTestTube'/>
                    </span>
                  </button>
                  {isDotsMenuOpen && (
                    <>
                      <button
                        className='btn btnEdit'
                        disabled={isPending}
                        onClick={() => startEditPlant(plant)}
                      >
                        <span>
                          <img src={iconEmojiPencil} alt='iconEmojiPencil'/>
                        </span>
                      </button>
                      <button
                        className={`btn btnPin ${isPinned ? 'btnPin--active' : ''}`}
                        disabled={isPending}
                        onClick={() => runAction(
                          () => togglePinPlant(plant.id, isPinned),
                          'Не удалось изменить закрепление. Попробуйте ещё раз.'
                        )}
                      >
                        <span>
                          <img src={iconEmojiPushpin} alt='iconEmojiPushpin'/>
                        </span>
                      </button>
                      <button
                        className={`btn btnReplant ${needReplant ? 'btnReplant--active' : ''}`}
                        disabled={isPending}
                        onClick={() => runAction(
                          () => toggleNeedReplant(plant.id, needReplant),
                          'Не удалось изменить отметку пересадки. Попробуйте ещё раз.'
                        )}
                      >
                        <span>
                          <img src={iconEmojiShovel} alt='iconEmojiShovel'/>
                        </span>
                      </button>
                      <button
                        className={`btn btnHide ${isHidden ? 'btnHide--active' : ''}`}
                        disabled={isPending}
                        onClick={() => runAction(
                          () => toggleHidePlant(plant.id, isHidden),
                          'Не удалось изменить видимость растения. Попробуйте ещё раз.'
                        )}
                      >
                        <span>
                          <img src={iconEmojiEye} alt='iconEmojiEye'/>
                        </span>
                        <span>
                          <img src={iconEmojiEyeOff} alt='iconEmojiEyeOff'/>
                        </span>
                      </button>
                      <button
                        className='btn btnDelete'
                        disabled={isPending}
                        onClick={() => runAction(
                          () => handleDeletePlant(plant.id),
                          'Не удалось переместить растение в корзину. Попробуйте ещё раз.'
                        )}
                      >
                        <span>
                          <img src={iconEmojiWastebasket} alt='iconEmojiWastebasket'/>
                        </span>
                      </button>
                    </>
                  )}
                  <button
                    className='btn btnDotsMenu'
                    onClick={() => setIsDotsMenuOpen((prev) => !prev)}
                  >
                    {isDotsMenuOpen ? (
                      <span><img src={closeIcon} alt='close'/></span>
                    ) : (
                      <span><img src={dotsMenuIcon} alt='menu'/></span>
                    )}
                  </button>
                </div>
              )}

              {isTrash && (
                <div className='btnsWrap cardBtns'>
                  <button
                    className="btn btnRestore"
                    aria-label="Восстановить растение"
                    disabled={isPending}
                    onClick={() => runAction(
                      () => restorePlant(plant.id),
                      'Не удалось восстановить растение. Попробуйте ещё раз.'
                    )}
                  >
                    <span><img src={recycleIcon} alt='' /></span>
                  </button>

                  <button
                    className="btn btnDelete"
                    aria-label="Удалить растение навсегда"
                    disabled={isPending}
                    onClick={() => runAction(
                      () => permanentlyDeletePlant(plant.id),
                      'Не удалось удалить растение навсегда. Попробуйте ещё раз.'
                    )}
                  >
                    <span><img src={iconEmojiWastebasket} alt='' /></span>
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default PlantCard;
