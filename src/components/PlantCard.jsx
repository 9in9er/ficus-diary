import { useState } from 'react';
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

function PlantCard({
  plant,
  editingId,
  editPlant,
  startEditPlant,
  saveEditPlant,
  cancelEdit,
  handleWaterPlant,
  handleFertilizePlant,
  deleteWateringEntry,
  deleteFertilizingEntry,
  handleEditPhotoChange,
  handleDeletePlant,
  formatDate,
  getDaysSinceLastWatering,
  getDaysSinceLastFertilizing,
  toggleNeedReplant,
  togglePinPlant,
  toggleHidePlant,
  addNoteToPlant,
  deleteNoteFromPlant,
  noteText,
  changeNoteText,
  showOnlyHidden,
  isTrash = false,
  restorePlant,
  permanentlyDeletePlant,
  getDaysUntilDelete,
}) {
  const [isDotsMenuOpen, setIsDotsMenuOpen] = useState(false);
  const isEditing = editingId === plant.id;
  const notes = plant.notes || [];
  const sortedNotes = [...notes].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );
  const latestNotes = sortedNotes.slice(0, 3);
  const olderNotes = sortedNotes.slice(3);
  const wateringLog = Array.isArray(plant.wateringLog) ? plant.wateringLog : [];
  const fertilizingLog = Array.isArray(plant.fertilizingLog) ? plant.fertilizingLog : [];
  const daysSinceLast = getDaysSinceLastWatering(wateringLog);
  const daysSinceLastFertilizing = getDaysSinceLastFertilizing(fertilizingLog);
  const needReplant = !!plant.replanted;
  const isPinned = !!plant.pinned;
  const isHidden = !!plant.hidden;

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
      className={`plantWrap ${isPinned ? 'plantWrap--pinned' : ''} ${isTrash ? "plantWrap--trash" : ""}`}
      onMouseLeave={() => setIsDotsMenuOpen(false)}
    >
      <div className='plantInfo'>
        {isEditing ? (
          <PlantForm
            name={editPlant.name}
            acquiredAt={editPlant.acquiredAt}
            onNameChange={(newName) =>
              startEditPlant({ ...editPlant, id: plant.id, name: newName })
            }
            onDateChange={(newDate) =>
              startEditPlant({ ...editPlant, id: plant.id, acquiredAt: newDate })
            }
            onPhotoChange={handleEditPhotoChange}
            onSubmit={(e) => {
              e.preventDefault(); // чтобы страница не перезагружалась при отправке формы
              saveEditPlant(plant.id);
            }}
            onCancel={cancelEdit}
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

                  <div className='aboutWatering'>
                    {wateringLog.length > 0 && !isTrash ? (
                      <details>
                        <summary>
                          <strong>Последний полив: <br /></strong>
                          <span>
                            {daysSinceLast === 0
                              ? 'сегодня'
                              : `${daysSinceLast} дн. назад`}
                          </span>
                        </summary>

                        <ul className='wateringList'>
                          {[...wateringLog].reverse().map((date) => (
                            <li key={date}>
                              {formatDate(date)}
                              <button
                                className='btn btnDelete'
                                type='button'
                                onClick={() =>
                                  deleteWateringEntry(plant.id, wateringLog, date)
                                }
                              >
                                ✖
                              </button>
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : (
                      <p>
                        <strong>Последний полив: <br /></strong>
                        <span>ещё не поливали</span>
                      </p>
                    )}
                  </div>

                  <div className='aboutFertilizing'>
                    {fertilizingLog.length > 0 && !isTrash ? (
                      <details>
                        <summary>
                          <strong>Последнее удобрение: <br /></strong>
                          <span>
                            {daysSinceLastFertilizing === 0
                              ? 'сегодня'
                              : `${daysSinceLastFertilizing} дн. назад`}
                          </span>
                        </summary>

                        <ul className='fertilizingList'>
                          {[...fertilizingLog].reverse().map((date) => (
                            <li key={date}>
                              {formatDate(date)}
                              <button
                                className='btn btnDelete'
                                type='button'
                                onClick={() =>
                                  deleteFertilizingEntry(
                                    plant.id,
                                    fertilizingLog,
                                    date
                                  )
                                }
                              >
                                ✖
                              </button>
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : (
                      <p>
                        <strong>Последнее удобрение: <br /></strong>
                        <span>ещё не удобряли</span>
                      </p>
                    )}
                  </div>

                </div>
                <div className='textInfos'>
                  <p className='dateOfAppearance'>
                    <strong>Дата появления: </strong>
                    {plant.acquiredAt ? formatDate(plant.acquiredAt) : 'неизвестно'}
                  </p>

                  <div className='notesBlock'>
                    {!isTrash && (
                      <div className='notesAdd'>
                        <input
                          className='input notesInput'
                          type='text'
                          placeholder='Новая заметка...'
                          value={noteText}
                          onChange={(e) => changeNoteText(plant.id, e.target.value)}
                        />
                        <button
                          className='btn btnSubmit'
                          type='button'
                          onClick={() => {
                            addNoteToPlant(plant.id, notes, noteText);
                            changeNoteText(plant.id, '');
                          }}
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
