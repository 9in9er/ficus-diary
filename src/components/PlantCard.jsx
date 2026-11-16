import { useState } from 'react';
import useAutoResizeTextarea from '../hooks/useAutoResizeTextarea';
import { formatDate, getDaysUntilDelete } from '../utils/plantDates';
import PlantCareHistory from './PlantCareHistory';
import '../styles/PlantCard.scss';

import iconEmojiDroplet from '../i/icons/droplet.svg';
import iconEmojiTestTube from '../i/icons/flask-conical.svg';
import iconEmojiPencil from '../i/icons/pencil.svg';
import iconEmojiPushpin from '../i/icons/pin.svg';
import iconEmojiEye from '../i/icons/eye.svg';
import iconEmojiEyeOff from '../i/icons/eye-off.svg';
import iconEmojiWastebasket from '../i/icons/trash.svg';
import iconEmojiShovel from '../i/icons/shovel.svg';

import dotsMenuIcon from '../i/icons/dots-menu.svg';
import closeIcon from '../i/icons/close.svg';

import PlantForm from './PlantForm';

function PlantCard({ plant, actions, editor, noteText, onNoteTextChange, isTrash = false }) {
  const {
    handleWaterPlant, handleFertilizePlant, deleteWateringEntry, deleteFertilizingEntry,
    handleDeletePlant, toggleNeedReplant, togglePinPlant, toggleHidePlant,
    addNoteToPlant, deleteNoteFromPlant, restorePlant, permanentlyDeletePlant,
  } = actions;
  const { editingId, draft: editPlant, startEdit: startEditPlant, cancelEdit, handlePhotoChange } = editor;
  const [isDotsMenuOpen, setIsDotsMenuOpen] = useState(false);
  const [isSavingNote, setIsSavingNote] = useState(false);
  const [noteError, setNoteError] = useState('');
  const [isSavingEdit, setIsSavingEdit] = useState(false);
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
    if (isSavingNote || !noteText.trim()) return;
    setNoteError('');
    setIsSavingNote(true);
    try {
      await addNoteToPlant(plant.id, notes, noteText);
      onNoteTextChange('');
    } catch {
      setNoteError('Не удалось сохранить заметку. Попробуйте ещё раз.');
    } finally {
      setIsSavingNote(false);
    }
  };

  const submitEdit = async (event) => {
    event.preventDefault();
    if (isSavingEdit || editor.isProcessingPhoto) return;
    if (!editPlant.name.trim()) {
      setEditError('Введите название растения.');
      return;
    }
    setEditError('');
    setIsSavingEdit(true);
    try {
      await actions.savePlant(plant.id, editPlant);
      cancelEdit();
    } catch {
      setEditError('Не удалось сохранить изменения. Попробуйте ещё раз.');
    } finally {
      setIsSavingEdit(false);
    }
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
          onClick={() => deleteNoteFromPlant(plant.id, notes, note.id)}
        >
          ✖
        </button>
      )}
    </li>
  );

  return (
    <div
      role='listitem'
      className={`plantWrap ${isPinned ? 'plantWrap--pinned' : ''} ${isTrash ? "plantWrap--trash" : ""}`}
      onMouseLeave={() => setIsDotsMenuOpen(false)}
    >
      <div className='plantInfo'>
        {isEditing ? (
          <PlantForm
            name={editPlant.name}
            acquiredAt={editPlant.acquiredAt}
            onNameChange={(newName) =>
              editor.setField('name', newName)
            }
            onDateChange={(newDate) =>
              editor.setField('acquiredAt', newDate)
            }
            onPhotoChange={handlePhotoChange}
            onSubmit={submitEdit}
            onCancel={() => { setEditError(''); cancelEdit(); }}
            isSubmitting={isSavingEdit}
            error={editError || editor.photoError}
            isProcessingPhoto={editor.isProcessingPhoto}
          />
        ) : (
          <>
            <div className='aboutPlant'>
              <div className={`badge badge--replant ${needReplant ? 'badge--active' : ''}`}><img src={iconEmojiShovel} alt='iconEmojiShovel'/></div>
              <h3 className='plantName'>{plant.name}</h3>
              <div className="aboutPlantWrap">
                <div className='photoInfo'>
                  {plant.photo && (
                    <img
                      className='plantPhoto'
                      src={plant.photo}
                      alt={plant.name}
                    />
                  )}

                  <PlantCareHistory
                    plantId={plant.id}
                    log={wateringLog}
                    title='Последний полив'
                    emptyMessage='ещё не поливали'
                    className='aboutWatering'
                    listClassName='wateringList'
                    isTrash={isTrash}
                    onDelete={deleteWateringEntry}
                  />
                  <PlantCareHistory
                    plantId={plant.id}
                    log={fertilizingLog}
                    title='Последнее удобрение'
                    emptyMessage='ещё не удобряли'
                    className='aboutFertilizing'
                    listClassName='fertilizingList'
                    isTrash={isTrash}
                    onDelete={deleteFertilizingEntry}
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
                          disabled={isSavingNote}
                          onChange={(e) => onNoteTextChange(e.target.value)}
                        />
                        <button
                          className='btn btnSubmit'
                          type='button'
                          onClick={submitNote}
                          disabled={isSavingNote}
                          aria-label='Сохранить заметку'
                        >
                          ↩
                        </button>
                      </div>
                    )}
                    {noteError && <p className='formError' role='alert'>{noteError}</p>}

                    {sortedNotes.length === 0 && (
                      <p className='notesEmpty'>Пока нет заметок.</p>
                    )}

                    {sortedNotes.length > 0 && (
                      <>
                        <ul className='notesList'>
                          {latestNotes.map(renderNoteItem)}
                        </ul>
                        {(olderNotes.length > 0 && !isTrash) && (
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

                        <p>
                            До удаления осталось:{' '}
                              <span>{getDaysUntilDelete(plant.deletedAt)}
                            дн.</span>
                        </p>

                    </div>
                  )}
                </div>
              </div>
              
              {!isTrash && (
                <div className='btnsWrap cardBtns'>
                  <button
                    className='btn btnWatering'
                    onClick={() => handleWaterPlant(plant.id, wateringLog)}
                  >
                    <span>
                      <img src={iconEmojiDroplet} alt='iconEmojiDroplet'/>
                    </span>
                  </button>
                  <button
                    className='btn btnFertilizing'
                    onClick={() => handleFertilizePlant(plant.id, fertilizingLog)}
                  >
                    <span>
                      <img src={iconEmojiTestTube} alt='iconEmojiTestTube'/>
                    </span>
                  </button>
                  {isDotsMenuOpen && (
                    <>
                      <button
                        className='btn btnEdit'
                        onClick={() => startEditPlant(plant)}
                      >
                        <span>
                          <img src={iconEmojiPencil} alt='iconEmojiPencil'/>
                        </span>
                      </button>
                      <button
                        className={`btn btnPin ${isPinned ? 'btnPin--active' : ''}`}
                        onClick={() => togglePinPlant(plant.id, isPinned)}
                      >
                        <span>
                          <img src={iconEmojiPushpin} alt='iconEmojiPushpin'/>
                        </span>
                      </button>
                      <button
                        className={`btn btnReplant ${needReplant ? 'btnReplant--active' : ''}`}
                        onClick={() => toggleNeedReplant(plant.id, needReplant)}
                      >
                        <span>
                          <img src={iconEmojiShovel} alt='iconEmojiShovel'/>
                        </span>
                      </button>
                      <button
                        className={`btn btnHide ${isHidden ? 'btnHide--active' : ''}`}
                        onClick={() => toggleHidePlant(plant.id, isHidden)}
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
                        onClick={() => handleDeletePlant(plant.id)}
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
                    onClick={() => restorePlant(plant.id)}
                >
                    ♻️
                </button>

                <button
                    className="btn btnDelete"
                    onClick={() => permanentlyDeletePlant(plant.id)}
                >
                    🗑️
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
