import { useEffect, useState } from 'react';
import { collection, addDoc, query, where, onSnapshot, doc, updateDoc, deleteDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { DAY_IN_MS, TRASH_RETENTION_DAYS, getLocalDate } from '../utils/plantDates';
import { getWishlistDetails } from '../utils/wishlist';

const CARE_LOG_LIMIT = 8;

export function usePlants(user) {
  const [plants, setPlants] = useState([]);
  const [loadingPlants, setLoadingPlants] = useState(true);
  const [plantsError, setPlantsError] = useState('');
  const userId = user?.uid;

  useEffect(() => {
    setPlants([]);
    setPlantsError('');
    if (!userId) {
      setLoadingPlants(false);
      return;
    }
    setLoadingPlants(true);
    const plantsQuery = query(collection(db, 'plants'), where('userId', '==', userId));
    return onSnapshot(plantsQuery, (snapshot) => {
      setPlants(snapshot.docs.map((item) => ({ ...item.data(), id: item.id })));
      setLoadingPlants(false);
    }, () => {
      setPlantsError('Не удалось загрузить растения. Обновите страницу и попробуйте ещё раз.');
      setLoadingPlants(false);
    });
  }, [userId]);

  useEffect(() => {
    const clearTrash = async () => {
      for (const plant of plants) {
        if (!plant.deletedAt) continue;
        const daysInTrash = (Date.now() - new Date(plant.deletedAt)) / DAY_IN_MS;
        if (daysInTrash >= TRASH_RETENTION_DAYS) {
          await deleteDoc(doc(db, 'plants', plant.id));
        }
      }
    };
    clearTrash().catch(() => {
      setPlantsError('Не удалось очистить старые записи в корзине. Попробуйте обновить страницу позже.');
    });
  }, [plants]);

  const updatePlant = (id, changes) => updateDoc(doc(db, 'plants', id), changes);

  const createPlant = async (draft) => {
    if (!draft.name.trim() || !userId) throw new Error('Не заполнены данные растения или аккаунта.');
    await addDoc(collection(db, 'plants'), {
      name: draft.name,
      photo: draft.photo,
      acquiredAt: draft.acquiredAt,
      wateringLog: [], fertilizingLog: [], notes: [],
      userId,
      createdAt: new Date().toISOString(),
      pinned: false, hidden: false, deletedAt: null,
    });
  };

  const savePlant = (id, draft) => updatePlant(id, {
    name: draft.name, acquiredAt: draft.acquiredAt, photo: draft.photo,
  });

  const createWish = async (draft) => {
    if (!draft.name.trim() || !userId) throw new Error('Не заполнены данные растения или аккаунта.');
    await addDoc(collection(db, 'plants'), {
      name: draft.name.trim(), photo: draft.photo,
      ...getWishlistDetails(draft),
      isWishlisted: true, userId, createdAt: new Date().toISOString(),
      deletedAt: null, hidden: false, pinned: false,
    });
  };

  const saveWish = (id, draft) => updatePlant(id, {
    name: draft.name.trim(), photo: draft.photo, ...getWishlistDetails(draft),
  });

  const appendCareEntry = (id, field, log) => {
    const entries = Array.isArray(log) ? log : [];
    return updatePlant(id, { [field]: [...entries, new Date().toISOString()].slice(-CARE_LOG_LIMIT) });
  };

  const deleteCareEntry = (id, field, log, entryToDelete) => {
    const entries = Array.isArray(log) ? log : [];
    return updatePlant(id, { [field]: entries.filter((entry) => entry !== entryToDelete) });
  };

  const addNoteToPlant = async (id, notes, text) => {
    if (!text.trim()) return;
    await updatePlant(id, { notes: [...(notes || []), {
      id: Date.now().toString(), text, createdAt: new Date().toISOString(),
    }] });
  };

  const actions = {
    createPlant,
    savePlant,
    createWish,
    saveWish,
    acquireWish: (id) => updatePlant(id, {
      isWishlisted: false, acquiredAt: getLocalDate(),
      createdAt: new Date().toISOString(),
      wateringLog: [], fertilizingLog: [], notes: [],
      pinned: false, hidden: false, replanted: false, deletedAt: null,
    }),
    handleDeletePlant: (id) => updatePlant(id, {
      deletedAt: new Date().toISOString(), hidden: false, pinned: false,
    }),
    restorePlant: (id) => updatePlant(id, { deletedAt: null }),
    permanentlyDeletePlant: (id) => deleteDoc(doc(db, 'plants', id)),
    handleWaterPlant: (id, log) => appendCareEntry(id, 'wateringLog', log),
    handleFertilizePlant: (id, log) => appendCareEntry(id, 'fertilizingLog', log),
    deleteWateringEntry: (id, log, entry) => deleteCareEntry(id, 'wateringLog', log, entry),
    deleteFertilizingEntry: (id, log, entry) => deleteCareEntry(id, 'fertilizingLog', log, entry),
    addNoteToPlant,
    deleteNoteFromPlant: (id, notes, noteId) => updatePlant(id, {
      notes: (notes || []).filter((note) => note.id !== noteId),
    }),
    // Сохраняем существующее имя поля Firestore для совместимости с данными.
    toggleNeedReplant: (id, needsReplant) => updatePlant(id, { replanted: !needsReplant }),
    togglePinPlant: (id, pinned) => updatePlant(id, { pinned: !pinned }),
    toggleHidePlant: (id, hidden) => updatePlant(id, { hidden: !hidden }),
  };

  return { plants, loadingPlants, plantsError, actions };
}
