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

function PlantsPage() {
    const auth = useAuth();
    
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

                {!showTrash && (
                    <div className='plantListWrap'>
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
                    <div className="plantListWrap">
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
