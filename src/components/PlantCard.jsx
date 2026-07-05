import { useState } from 'react';
import '../styles/PlantCard.scss';

import dotsMenuIcon from '../i/dots-menu.svg';
import closeIcon from '../i/close.svg';

function PlantCard({
  plant,
  editingId,
  editPlant,
  startEditPlant,
  saveEditPlant,
  cancelEdit,
  handleWaterPlant,
  deleteWateringEntry,
  handleEditPhotoChange,
  handleDeletePlant,
  formatDate,
  getLastWatering,
  getDaysSinceLastWatering,
  togglePinPlant,
  toggleHidePlant,
  addNoteToPlant,
  deleteNoteFromPlant,
  noteText,
  changeNoteText,
  showOnlyHidden,
}) {
  const [isDotsMenuOpen, setIsDotsMenuOpen] = useState(false);
  const isEditing = editingId === plant.id;
  const notes = plant.notes || [];
  const sortedNotes = [...notes].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );
  const latestNotes = sortedNotes.slice(0, 3);
  const olderNotes = sortedNotes.slice(3);
  const log = Array.isArray(plant.wateringLog) ? plant.wateringLog : [];
  const daysSinceLast = getDaysSinceLastWatering(log);
  const isPinned = !!plant.pinned;
  const isHidden = !!plant.hidden;

  return (
    <div className={`plantWrap ${isPinned ? 'plantWrap--pinned' : ''} ${isHidden && !showOnlyHidden ? 'plantWrap--hidden' : ''}`}>
      <div className='plantInfo'>
        {isEditing ? (
          <div className='mainForm'>
            <div className='mainForm_wrap'>
              <div className='nameAndDate'>
                <label className='nameLabel'>
                  Название растения
                  <input
                    className='input inputPlantName'
                    type='text'
                    value={editPlant.name}
                    onChange={(e) =>
                      startEditPlant({ ...plant, name: e.target.value })
                    }
                  />
                </label>
                <label className='dateLabel'>
                  Дата появления
                  <input
                    className='plantDate'
                    type='date'
                    value={editPlant.acquiredAt}
                    onChange={(e) =>
                      startEditPlant({ ...plant, acquiredAt: e.target.value })
                    }
                  />
                </label>
              </div>

              <input
                className='fileLoad'
                type='file'
                accept='image/*'
                onChange={handleEditPhotoChange}
              />

              <div className='btnsWrap btnsWrapEditing'>
                <button
                  className='btn btnSubmit'
                  onClick={() => saveEditPlant(plant.id)}
                >
                  Сохранить
                </button>
                <button className='btn btnCancel' onClick={cancelEdit}>
                  Отмена
                </button>
              </div>

            </div>
          </div>
        ) : (
          <>
            <div className='aboutPlant'>
              <h3 className='plantNameMob'>{plant.name}</h3>
              <div className='photoInfo'>
                {(isEditing ? editPlant?.photo : plant.photo) && (
                  <img
                    className='plantPhoto'
                    src={isEditing ? editPlant?.photo : plant.photo}
                    alt={isEditing ? editPlant?.name || plant.name : plant.name}
                  />
                )}

                <p className='dateOfAppearance'>
                  <strong>Дата появления: </strong>
                  {plant.acquiredAt ? new Date(plant.acquiredAt).toLocaleDateString('ru-RU') : 'неизвестно'}
                </p>

                <div className='aboutWatering'>
                  <p>
                    <strong>Последний полив: <br /></strong>
                    {/* {getLastWatering(log)} */}
                    {daysSinceLast !== null && (
                      <span> {daysSinceLast === 0 ? 'сегодня' : `${daysSinceLast} дн. назад`} </span>
                    )}
                  </p>

                  {log.length > 0 && (
                    <details>
                      <summary>История поливов ({log.length})</summary>
                      <ul className='wateringList'>
                        {[...log].reverse().slice(0, 8).map((date, index) => (
                          <li key={index}>
                            {formatDate(date)}
                            <button
                              className='btn btnDelete'
                              type='button'
                              onClick={() => deleteWateringEntry(plant.id, log, date)
                              }
                            >
                              ✖
                            </button>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>

              </div>
              <div className='textInfos'>
                <h3 className='plantName'>{plant.name}</h3>
                <div className='notesBlock'>
                  <h4>Заметки</h4>

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
                      Добавить
                    </button>
                  </div>

                  {sortedNotes.length === 0 && (
                    <p className='notesEmpty'>Пока нет заметок.</p>
                  )}

                  {sortedNotes.length > 0 && (
                    <>
                      <ul className='notesList'>
                        {latestNotes.map((note) => (
                          <li key={note.id} className='notesItem'>
                            <div>
                              <div className='notesText'>{note.text}</div>
                              <div className='notesDate'>
                                {formatDate(note.createdAt)}{' '}
                                {new Date(
                                  note.createdAt
                                ).toLocaleTimeString('ru-RU', {
                                  hour: '2-digit',
                                  minute: '2-digit',
                                })}
                              </div>
                            </div>
                            <button
                              className='btn btnDelete'
                              type='button'
                              onClick={() =>
                                deleteNoteFromPlant(plant.id, notes, note.id)
                              }
                            >
                              ✖
                            </button>
                          </li>
                        ))}
                      </ul>
                      {olderNotes.length > 0 && (
                        <details className='notesMore'>
                          <summary>
                            Показать все заметки ({sortedNotes.length - 3})
                          </summary>

                          <ul className='notesList'>
                            {olderNotes.map((note) => (
                              <li key={note.id} className='notesItem'>
                                <div>
                                  <div className='notesText'>{note.text}</div>
                                  <div className='notesDate'>
                                    {formatDate(note.createdAt)}{' '}
                                    {new Date(
                                      note.createdAt
                                    ).toLocaleTimeString('ru-RU', {
                                      hour: '2-digit',
                                      minute: '2-digit',
                                    })}
                                  </div>
                                </div>
                                <button
                                  className='btn btnDelete'
                                  type='button'
                                  onClick={() =>
                                    deleteNoteFromPlant(
                                      plant.id,
                                      notes,
                                      note.id
                                    )
                                  }
                                >
                                  ✖
                                </button>
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </>
                  )}
                </div>
              </div>
              
              <div className='btnsWrap'>
                <button
                  className='btn btnWatering'
                  onClick={() => handleWaterPlant(plant.id, log)}
                >
                  💧
                </button>
                {isDotsMenuOpen && (
                  <>
                    <button
                      className='btn btnEdit'
                      onClick={() => startEditPlant(plant)}
                    >
                      ✏️
                    </button>
                    <button
                      className={`btn btnPin ${isPinned ? 'btnPin--active' : ''}`}
                      onClick={() => togglePinPlant(plant.id, isPinned)}
                    >
                      <span>📌</span>
                    </button>
                    <button
                      className={`btn btnHide ${isHidden ? 'btnHide--active' : ''}`}
                      onClick={() => toggleHidePlant(plant.id, isHidden)}
                    >
                      👁️
                    </button>
                    <button
                      className='btn btnDelete'
                      onClick={() => handleDeletePlant(plant.id)}
                    >
                      🗑️
                    </button>
                  </>
                )}
                <button
                  className='btn btnDotsMenu'
                  onClick={() => setIsDotsMenuOpen((prev) => !prev)}
                >
                  {isDotsMenuOpen ? (
                    <img src={closeIcon} alt='close'/>
                  ) : (
                    <img src={dotsMenuIcon} alt='menu'/>
                  )}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default PlantCard;
