import { useEffect, useState } from 'react';
import { usePlants } from '../hooks/usePlants';
import { useAuth } from '../hooks/useAuth';
import usePlantDraft from '../hooks/usePlantDraft';
import usePlantEditor from '../hooks/usePlantEditor';
import usePlantFilters from '../hooks/usePlantFilters';
import usePlantGridLayout from '../hooks/usePlantGridLayout';
import usePlantActions from '../hooks/usePlantActions';
import PlantForm from './PlantForm';
import PlantCard from './PlantCard';
import ScrollToTop from './ScrollToTop';
import Footer from './Footer';
import PlantsToolbar from './PlantsToolbar';
import ModalDialog from './ModalDialog';
import WishlistCard from './WishlistCard';
import WishlistForm from './WishlistForm';
import { getWishlistDetails } from '../utils/wishlist';

function PlantsPage({ isWishlist = false }) {
    const { user } = useAuth();
    const { plants, loadingPlants, plantsError, actions } = usePlants(user);
    const { runAction, pendingPlantIds, actionError } = usePlantActions();
    const pagePlants = plants.filter((plant) => !!plant.isWishlisted === isWishlist);
    const filters = usePlantFilters(pagePlants, isWishlist ? 'wishlistSortMode' : 'plantsSortMode');
    const { showTrash, showOnlyNeedReplant, sortedPlants, sortedTrashPlants } = filters;
    const addForm = usePlantDraft();
    const editor = usePlantEditor();
    const [isAddModalOpen, setIsAddModalOpen] = useState(false);
    const [isAddingPlant, setIsAddingPlant] = useState(false);
    const [addPlantError, setAddPlantError] = useState('');
    const [acquiredWishName, setAcquiredWishName] = useState('');
    const [noteTextByPlant, setNoteTextByPlant] = useState({});
    const { regularColumns, compactColumns } = usePlantGridLayout();
    const gridStorageKey = isWishlist ? 'wishlistGridColumns' : 'plantsGridColumns';
    const [gridColumns, setGridColumns] = useState(
        () => {
            const savedColumns = Number(localStorage.getItem(gridStorageKey));
            if (isWishlist) return [2, 3, 4].includes(savedColumns) ? savedColumns : 4;
            if ([5, 6, 7].includes(savedColumns)) return 8;
            return [2, 3, 4, 8].includes(savedColumns) ? savedColumns : 4;
        }
    );
    const [mobileCompact, setMobileCompact] = useState(
        () => !isWishlist && localStorage.getItem('plantsMobileCompact') === 'true'
    );

    useEffect(() => {
        localStorage.setItem(gridStorageKey, String(gridColumns));
    }, [gridColumns, gridStorageKey]);

    useEffect(() => {
        if (!isWishlist) localStorage.setItem('plantsMobileCompact', String(mobileCompact));
    }, [mobileCompact, isWishlist]);
    
    // Preserve the preferred mode while adapting its column count to the viewport.
    const visibleGridColumns = !isWishlist && gridColumns === 8
        ? (compactColumns || 4)
        : Math.min(Math.max(gridColumns, regularColumns[0]), regularColumns[regularColumns.length - 1]);
    const plantListClassName = `plantListWrap plantListWrap--columns-${visibleGridColumns} ${!isWishlist && mobileCompact ? 'plantListWrap--mobile-compact' : ''}`;

    const submitNewPlant = async (event) => {
        event.preventDefault();
        if (isAddingPlant || addForm.isProcessingPhoto) return;
        if (!addForm.draft.name.trim()) {
            setAddPlantError('Введите название растения.');
            return;
        }
        setAddPlantError('');
        setIsAddingPlant(true);
        try {
            if (isWishlist) {
                getWishlistDetails(addForm.draft);
                await actions.createWish(addForm.draft);
            } else await actions.createPlant(addForm.draft);
            addForm.resetDraft();
            setIsAddModalOpen(false);
        } catch (error) {
            setAddPlantError(error.photoError || error.message === 'Укажите корректные ссылки на сайты, каждую с новой строки.'
                ? error.message : 'Не удалось сохранить растение. Попробуйте ещё раз.');
        } finally {
            setIsAddingPlant(false);
        }
    };

    const closeAddModal = () => {
        if (isAddingPlant) return;
        setIsAddModalOpen(false);
        setAddPlantError('');
    };
    

    const visiblePlants = showTrash ? sortedTrashPlants : sortedPlants;
    let emptyMessage = '';
    if (!loadingPlants && !plantsError && visiblePlants.length === 0) {
        if (showTrash) emptyMessage = 'Корзина пуста.';
        else if (filters.searchQuery) emptyMessage = 'По вашему запросу растения не найдены. Попробуйте изменить поиск или фильтры.';
        else if (pagePlants.length === 0) emptyMessage = isWishlist ? 'Добавьте первое растение в вишлист!' : 'Добавьте первое растение!';
        else if (showOnlyNeedReplant) emptyMessage = 'Нет растений для пересадки с учётом выбранных фильтров.';
        else emptyMessage = 'Нет растений с учётом выбранных фильтров.';
    }

    return (
        <>
            <div className='mainBlock plantsPage'>
                <PlantsToolbar
                    isWishlist={isWishlist}
                    count={visiblePlants.length}
                    trashCount={sortedTrashPlants.length}
                    onAdd={() => { setAddPlantError(''); setIsAddModalOpen(true); }}
                    searchQuery={filters.searchQuery}
                    setSearchQuery={filters.setSearchQuery}
                    sortMode={filters.sortMode}
                    setSortMode={filters.setSortMode}
                    showOnlyHidden={filters.showOnlyHidden}
                    setShowOnlyHidden={filters.setShowOnlyHidden}
                    showOnlyNeedReplant={showOnlyNeedReplant}
                    setShowOnlyNeedReplant={filters.setShowOnlyNeedReplant}
                    showTrash={showTrash}
                    setShowTrash={filters.setShowTrash}
                    gridColumns={visibleGridColumns >= 5 ? 8 : visibleGridColumns}
                    compactColumns={compactColumns}
                    regularColumns={regularColumns}
                    setGridColumns={setGridColumns}
                    mobileCompact={mobileCompact}
                    setMobileCompact={setMobileCompact}
                />

                {isAddModalOpen && (
                    <ModalDialog labelledBy='addPlantTitle' onClose={closeAddModal} isBusy={isAddingPlant}>
                        <h2 id='addPlantTitle'>{isWishlist ? 'Добавить в вишлист' : 'Добавить растение'}</h2>
                        {isWishlist ? <WishlistForm
                            form={addForm}
                            onSubmit={submitNewPlant}
                            onCancel={closeAddModal}
                            isSubmitting={isAddingPlant}
                            error={addPlantError}
                        /> : <PlantForm
                            photoForm={addForm}
                            name={addForm.draft.name}
                            acquiredAt={addForm.draft.acquiredAt}
                            onNameChange={(value) => addForm.setField('name', value)}
                            onDateChange={(value) => addForm.setField('acquiredAt', value)}
                            onSubmit={submitNewPlant}
                            onCancel={closeAddModal}
                            isSubmitting={isAddingPlant}
                            isProcessingPhoto={addForm.isProcessingPhoto}
                            error={addPlantError || addForm.photoError}
                        />}
                    </ModalDialog>
                )}

                {loadingPlants && <p className='startMessage'>Загружаем ваши растения…</p>}
                {plantsError && <p className='formError' role='alert'>{plantsError}</p>}
                {actionError && <p className='formError' role='alert'>{actionError}</p>}
                {isWishlist && acquiredWishName && <p role='status'>«{acquiredWishName}» теперь в разделе «Мои растения».</p>}

                {showTrash && isWishlist && <p className='wishlistHint'>Удалённые желания остаются в корзине до окончательного удаления. Их можно восстановить.</p>}
                <div className={plantListClassName} role='list' aria-label={isWishlist ? 'Вишлист' : 'Растения'}>
                    {emptyMessage && <p className='startMessage' role='status'>{emptyMessage}</p>}
                    {visiblePlants.map((plant) => (
                        isWishlist ? <WishlistCard
                            key={plant.id}
                            plant={plant}
                            actions={actions}
                            editor={editor}
                            isTrash={showTrash}
                            isPending={pendingPlantIds.has(plant.id)}
                            runAction={(action, errorMessage) => runAction(plant, action, errorMessage)}
                            onAcquired={() => setAcquiredWishName(plant.name)}
                        /> : <PlantCard
                            key={plant.id}
                            plant={plant}
                            actions={actions}
                            isPending={pendingPlantIds.has(plant.id)}
                            runAction={(action, errorMessage) => runAction(plant, action, errorMessage)}
                            editor={editor}
                            noteText={noteTextByPlant[plant.id] || ''}
                            onNoteTextChange={(value) => setNoteTextByPlant((previous) => ({ ...previous, [plant.id]: value }))}
                            isTrash={showTrash}
                        />
                    ))}
                </div>

            </div>
            <ScrollToTop />
            <Footer />
        </>
    );
}

export default PlantsPage;
