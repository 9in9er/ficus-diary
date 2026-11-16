import { useState } from 'react';
import usePlantDraft from './usePlantDraft';

export default function usePlantEditor() {
  const [editingId, setEditingId] = useState(null);
  const { resetDraft, ...form } = usePlantDraft();

  const startEdit = (plant) => {
    setEditingId(plant.id);
    resetDraft(plant);
  };

  const cancelEdit = () => {
    setEditingId(null);
    resetDraft();
  };

  return { ...form, editingId, startEdit, cancelEdit };
}
