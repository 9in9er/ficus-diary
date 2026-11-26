import { useEffect, useState } from 'react';

function comparePlants(a, b, sortMode) {
  if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
  if (sortMode === 'name') {
    return (a.name || '').localeCompare(b.name || '', 'ru', { sensitivity: 'base' });
  }
  if (sortMode === 'watering') {
    const aLast = Array.isArray(a.wateringLog) ? a.wateringLog.at(-1) : null;
    const bLast = Array.isArray(b.wateringLog) ? b.wateringLog.at(-1) : null;
    if (!aLast && !bLast) return 0;
    if (!aLast) return -1;
    if (!bLast) return 1;
    return aLast.localeCompare(bLast);
  }
  const aDate = a.createdAt || a.acquiredAt || '';
  const bDate = b.createdAt || b.acquiredAt || '';
  return bDate.localeCompare(aDate);
}

export default function usePlantFilters(plants, sortStorageKey = 'plantsSortMode') {
  const [searchQuery, setSearchQuery] = useState('');
  const [sortMode, setSortMode] = useState(() => localStorage.getItem(sortStorageKey) || 'date');
  const [showOnlyHidden, setShowOnlyHidden] = useState(false);
  const [showOnlyNeedReplant, setShowOnlyNeedReplant] = useState(false);
  const [showTrash, setShowTrash] = useState(false);

  useEffect(() => {
    localStorage.setItem(sortStorageKey, sortMode);
  }, [sortMode, sortStorageKey]);

  const normalizedSearch = searchQuery.toLowerCase();
  const sortedPlants = plants.filter((plant) => {
    if (plant.deletedAt || plant.soldAt) return false;
    if (!(plant.name || '').toLowerCase().includes(normalizedSearch)) return false;
    // В Firestore признак «нужна пересадка» исторически называется replanted.
    if (showOnlyNeedReplant && !plant.replanted) return false;
    return showOnlyHidden ? plant.hidden === true : !plant.hidden;
  }).sort((a, b) => comparePlants(a, b, sortMode));

  const sortedTrashPlants = plants.filter((plant) => plant.deletedAt)
    .sort((a, b) => new Date(b.deletedAt) - new Date(a.deletedAt));

  return {
    searchQuery, setSearchQuery, sortMode, setSortMode,
    showOnlyHidden, setShowOnlyHidden, showOnlyNeedReplant, setShowOnlyNeedReplant,
    showTrash, setShowTrash, sortedPlants, sortedTrashPlants,
  };
}
