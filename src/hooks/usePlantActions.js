import { useRef, useState } from 'react';

export default function usePlantActions() {
  const inFlight = useRef(new Set());
  const [pendingPlantIds, setPendingPlantIds] = useState(new Set());
  const [actionError, setActionError] = useState('');

  const runAction = async (plant, action, errorMessage, { propagateError = false } = {}) => {
    if (inFlight.current.has(plant.id)) return false;

    inFlight.current.add(plant.id);
    setPendingPlantIds(new Set(inFlight.current));
    setActionError('');
    try {
      await action();
      return true;
    } catch (error) {
      setActionError(`${plant.name}: ${error.photoError ? error.message : errorMessage}`);
      if (propagateError) throw error;
      return false;
    } finally {
      inFlight.current.delete(plant.id);
      setPendingPlantIds(new Set(inFlight.current));
    }
  };

  return { runAction, pendingPlantIds, actionError };
}
