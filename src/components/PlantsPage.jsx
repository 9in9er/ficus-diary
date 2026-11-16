import { useEffect, useState } from 'react';
import { usePlants } from '../hooks/usePlants';
import { useAuth } from '../hooks/useAuth';
import PlantForm from './PlantForm';
import PlantCard from './PlantCard';
import ScrollToTop from './ScrollToTop';
import Footer from './Footer';
import Header from './Header';

import iconEmojiUnlocked from '../i/icons/unlock.svg';
import iconEmojiLocked from '../i/icons/lock.svg';
import iconEmojiWastebasket from '../i/icons/trash.svg';
import iconEmojiHerb from '../i/icons/sprout.svg';
import iconEmojiShovel from '../i/icons/shovel.svg';
import { ReactComponent as GridThreeIcon } from '../i/icons/grid-3-columns.svg';
import { ReactComponent as GridFourIcon } from '../i/icons/grid-4-columns.svg';
import { ReactComponent as GridEightIcon } from '../i/icons/grid-8-columns.svg';
import { ReactComponent as GridOneIcon } from '../i/icons/grid-1-column.svg';
import { ReactComponent as GridTwoIcon } from '../i/icons/grid-2-columns.svg';

function PlantsPage() {
    const auth = useAuth();
    const [gridColumns, setGridColumns] = useState(
        () => {
            const savedColumns = Number(localStorage.getItem('plantsGridColumns'));
            if (savedColumns === 5 || savedColumns === 6) return 8;
            return [3, 4, 8].includes(savedColumns) ? savedColumns : 4;
        }
    );
    const [mobileCompact, setMobileCompact] = useState(
        () => localStorage.getItem('plantsMobileCompact') === 'true'
    );

    useEffect(() => {
        localStorage.setItem('plantsGridColumns', String(gridColumns));
    }, [gridColumns]);

    useEffect(() => {
        localStorage.setItem('plantsMobileCompact', String(mobileCompact));
    }, [mobileCompact]);
    
    const {
        plants,
        loadingPlants,
        name,
        setName,
        acquiredAt,
        setAcquiredAt,
        searchQuery,
        setSearchQuery,
        sortMode,
        setSortMode,
        isAddModalOpen,
        setIsAddModalOpen,
        noteTextByPlant,
        editingId,
        editPlant,
        handleAddPlant,
        handleDeletePlant,
        handleWaterPlant,
        handleFertilizePlant,
        deleteWateringEntry,
        deleteFertilizingEntry,
        handlePhotoChange,
        addNoteToPlant,
        deleteNoteFromPlant,
        changeNoteText,
        startEditPlant,
        handleEditPhotoChange,
        saveEditPlant,
        cancelEdit,
        formatDate,
        getDaysSinceLastWatering,
        getDaysSinceLastFertilizing,
        toggleNeedReplant,
        togglePinPlant,
        toggleHidePlant,
        showOnlyHidden,
        setShowOnlyHidden,
        showOnlyNeedReplant,
        setShowOnlyNeedReplant,
        sortedPlants,
        trashPlants,
        restorePlant,
        permanentlyDeletePlant,
        showTrash,
        setShowTrash,
        getDaysUntilDelete,
        sortedTrashPlants
    } = usePlants(auth.user);

    const plantListClassName = `plantListWrap plantListWrap--columns-${gridColumns} ${mobileCompact ? 'plantListWrap--mobile-compact' : ''}`;
    
    return (
        <>
            <div className='mainBlock'>
                <Header 
                    showCount={true}
                    count={showTrash ? sortedTrashPlants.length : sortedPlants.length}
                />

                <button className='btn btnLogOut' onClick={auth.handleLogout}>
                    Выйти
                </button>

                {isAddModalOpen && (
                    <div className='modalOverlay' onClick={() => setIsAddModalOpen(false)}>
                    <div className='modal' onClick={(e) => e.stopPropagation()}>
                        <h2>Добавить растение</h2>

                        <PlantForm
                        name={name}
                        acquiredAt={acquiredAt}
                        onNameChange={setName}
                        onDateChange={setAcquiredAt}
                        onPhotoChange={handlePhotoChange}
                        onSubmit={(e) => {
                            handleAddPlant(e);
                            setIsAddModalOpen(false);
                        }}
                        onCancel={() => setIsAddModalOpen(false)}
                        />
                    </div>
                    </div>
                )}

                {loadingPlants && (
                    <p className='startMessage'>Загружаем ваши растения…</p>
                )}

                <div className='topBar'>
                    <button
                    className='btn btnSubmit'
                    type='button'
                    onClick={() => setIsAddModalOpen(true)}
                    >
                    Добавить растение
                    </button>

                    <div className='gridControls gridControls--mobile' role='group' aria-label='Вид карточек на телефоне'>
                        {[
                            { compact: false, Icon: GridOneIcon, name: 'Обычные', label: 'Обычный вид: 1 карточка в ряду' },
                            { compact: true, Icon: GridTwoIcon, name: 'Компактные', label: 'Компактный вид: 2 карточки в ряду' },
                        ].map(({ compact, Icon, name, label }) => (
                            <button
                                key={name}
                                type='button'
                                className={`btn btnGridColumns ${mobileCompact === compact ? 'btnGridColumns--active' : ''}`}
                                aria-pressed={mobileCompact === compact}
                                aria-label={label}
                                title={label}
                                onClick={() => setMobileCompact(compact)}
                            >
                                <Icon aria-hidden='true' focusable='false' preserveAspectRatio='none' />
                                <span className='gridControlsLabel'>{name}</span>
                            </button>
                        ))}
                    </div>
                    
                    <div className="searchGroup">
                    <input
                        className='searchInput'
                        type='text'
                        placeholder='Поиск по названию'
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                    />
                    {searchQuery && (
                        <button
                        type='button'
                        className='btn clearSearch'
                        onClick={() => setSearchQuery('')}
                        aria-label='Очистить поиск'
                        >
                        ×
                        </button>
                    )}
                    </div>

                    <div className='sortControls'>
                    <label>
                        Сортировать по:{' '}
                        <select
                        value={sortMode}
                        onChange={(e) => setSortMode(e.target.value)}
                        >
                        <option value='date'>дата добавления (новые → старые)</option>
                        <option value='name'>имя (А → Я)</option>
                        <option value='watering'>последний полив (давно → недавно)</option>
                        </select>
                    </label>
                    </div>

                    <button
                        className={`btn btnToggleHidden ${showOnlyHidden ? 'btnToggleHidden--active' : ''}`}
                        onClick={() => setShowOnlyHidden(!showOnlyHidden)}
                        title={showOnlyHidden ? 'Показать все растения' : 'Показать скрытые растения'}
                    >
                        {showOnlyHidden ? (
                            <>
                                <span><img src={iconEmojiUnlocked} alt='iconEmojiUnlocked' /></span> Все
                            </>) : (
                            <>
                                <span><img src={iconEmojiLocked} alt='iconEmojiLocked' /></span> Скрытые
                            </>)}
                    </button>

                    <button
                        type='button'
                        className={`btn btnToggleReplant ${showOnlyNeedReplant ? 'btnToggleReplant--active' : ''}`}
                        onClick={() => {
                            setShowOnlyNeedReplant((current) => !current);
                            setShowTrash(false);
                        }}
                        aria-pressed={showOnlyNeedReplant}
                        title={showOnlyNeedReplant ? 'Снять фильтр по пересадке' : 'Показать растения, нуждающиеся в пересадке'}
                    >
                        <span><img src={iconEmojiShovel} alt='' /></span> На пересадку
                    </button>

                    <button
                        className={`btn btnTrash ${showTrash ? 'btnTrash--active' : ''}`}
                        onClick={() => setShowTrash(!showTrash)}
                    >
                        {showTrash ? (
                            <>
                                <span><img src={iconEmojiHerb} alt='iconEmojiHerb' /></span> Растения
                            </>
                        ) : (
                            <>
                                <span><img src={iconEmojiWastebasket} alt='iconEmojiWastebasket' /></span> Корзина ({trashPlants.length})
                            </>
                        )}
                    </button>

                </div>

                <div className='gridControls gridControls--desktop' role='group' aria-label='Вид карточек'>
                    {[
                        { columns: 3, Icon: GridThreeIcon, name: 'Крупные', label: 'Крупные: 3 карточки в ряду' },
                        { columns: 4, Icon: GridFourIcon, name: 'Средние', label: 'Средние: 4 карточки в ряду' },
                        { columns: 8, Icon: GridEightIcon, name: 'Компактные', label: 'Компактные: 8 карточек в ряду' },
                    ].map(({ columns, Icon, name, label }) => (
                        <button
                            key={columns}
                            type='button'
                            className={`btn btnGridColumns ${gridColumns === columns ? 'btnGridColumns--active' : ''}`}
                            aria-pressed={gridColumns === columns}
                            aria-label={label}
                            title={label}
                            onClick={() => setGridColumns(columns)}
                        >
                            <Icon aria-hidden='true' focusable='false' preserveAspectRatio='none' />
                            <span className='gridControlsLabel'>{name}</span>
                        </button>
                    ))}
                </div>

                {!showTrash && (
                    <div className={plantListClassName}>
                        {!loadingPlants && showOnlyNeedReplant && sortedPlants.length === 0 && (
                            <p className='startMessage'>Нет растений для пересадки с учётом выбранных фильтров.</p>
                        )}
                        {sortedPlants.map((plant) => (
                        <PlantCard
                            key={plant.id}
                            plant={plant}
                            editingId={editingId}
                            editPlant={editPlant}
                            startEditPlant={startEditPlant}
                            saveEditPlant={saveEditPlant}
                            cancelEdit={cancelEdit}
                            handleWaterPlant={handleWaterPlant}
                            handleFertilizePlant={handleFertilizePlant}
                            deleteWateringEntry={deleteWateringEntry}
                            deleteFertilizingEntry={deleteFertilizingEntry}
                            handleEditPhotoChange={handleEditPhotoChange}
                            handleDeletePlant={handleDeletePlant}
                            formatDate={formatDate}
                            getDaysSinceLastWatering={getDaysSinceLastWatering}
                            getDaysSinceLastFertilizing={getDaysSinceLastFertilizing}
                            toggleNeedReplant={toggleNeedReplant}
                            togglePinPlant={togglePinPlant}
                            toggleHidePlant={toggleHidePlant}
                            addNoteToPlant={addNoteToPlant}
                            deleteNoteFromPlant={deleteNoteFromPlant}
                            noteText={noteTextByPlant[plant.id] || ''}
                            changeNoteText={changeNoteText}
                            showOnlyHidden={showOnlyHidden}
                            isTrash={false}
                        />
                        ))}
                    </div>
                )}

                {showTrash && (
                    <div className={plantListClassName}>
                        {sortedTrashPlants.length === 0 ? (
                            <p>Корзина пуста.</p>
                        ) : (
                            sortedTrashPlants.map((plant) => (
                                <PlantCard
                                    key={plant.id}
                                    plant={plant}
                                    editingId={editingId}
                                    editPlant={editPlant}
                                    startEditPlant={startEditPlant}
                                    saveEditPlant={saveEditPlant}
                                    cancelEdit={cancelEdit}
                                    handleWaterPlant={handleWaterPlant}
                                    handleFertilizePlant={handleFertilizePlant}
                                    deleteWateringEntry={deleteWateringEntry}
                                    deleteFertilizingEntry={deleteFertilizingEntry}
                                    handleEditPhotoChange={handleEditPhotoChange}
                                    handleDeletePlant={handleDeletePlant}
                                    toggleNeedReplant={toggleNeedReplant}
                                    togglePinPlant={togglePinPlant}
                                    toggleHidePlant={toggleHidePlant}
                                    addNoteToPlant={addNoteToPlant}
                                    deleteNoteFromPlant={deleteNoteFromPlant}
                                    noteText={noteTextByPlant[plant.id] || ""}
                                    changeNoteText={changeNoteText}
                                    formatDate={formatDate}
                                    getDaysSinceLastWatering={getDaysSinceLastWatering}
                                    getDaysSinceLastFertilizing ={getDaysSinceLastFertilizing}
                                    showOnlyHidden={showOnlyHidden}
                                    isTrash={true}
                                    restorePlant={restorePlant}
                                    permanentlyDeletePlant={permanentlyDeletePlant}
                                    getDaysUntilDelete={getDaysUntilDelete}
                                />
                            ))
                        )}
                    </div>
                )}

                {!loadingPlants && plants.length === 0 && (
                    <p className='startMessage'>Добавьте первое растение!</p>
                )}
            </div>
            <ScrollToTop />
            <Footer />
        </>
    );
}

export default PlantsPage;
