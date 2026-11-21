import { useEffect, useRef, useState } from 'react';
import { useAuth } from './useAuth';
import { getPlantPhotoUrl, invalidatePlantPhotoUrl } from '../services/plantPhotoCache';

export default function usePlantPhoto(plant, enabled = true, variant = 'original') {
  const { user } = useAuth();
  const userId = user?.uid;
  const userRef = useRef(user);
  userRef.current = user;
  const [resolved, setResolved] = useState(null);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const requestVariant = variant === 'thumbnail' && plant.photoThumbKey ? 'thumbnail' : 'original';
  const photoKey = requestVariant === 'thumbnail' ? plant.photoThumbKey : plant.photoKey;
  useEffect(() => { setFailed(false); }, [plant.photo, photoKey, requestVariant]);
  useEffect(() => {
    const requestUser = userRef.current;
    if (!enabled || !plant.photoKey || !photoKey || !requestUser) return undefined;
    let cancelled = false;
    let timer;
    setFailed(false);
    const refresh = async () => {
      try {
        const url = await getPlantPhotoUrl(requestUser, plant.id, photoKey, requestVariant);
        if (cancelled) return;
        setResolved({ uid: userId, key: photoKey, variant: requestVariant, url });
        setFailed(false);
      } catch {
        if (cancelled) return;
        setFailed(true);
        timer = setTimeout(refresh, 30000);
      }
    };
    refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [enabled, plant.id, plant.photoKey, photoKey, requestVariant, userId, revision]);

  const current = !!plant.photoKey && resolved?.uid === userId && resolved?.key === photoKey && resolved?.variant === requestVariant;
  return {
    // Legacy data is a fallback after a failed read, not a second initial download.
    src: enabled ? (plant.photoKey
      ? (current && !failed && resolved.url) || (failed && plant.photo) || null
      : plant.photo || null) : null,
    failed,
    revision,
    retry: () => {
      if (current) invalidatePlantPhotoUrl(user.uid, photoKey, resolved.url, requestVariant);
      setResolved(null);
      setFailed(false);
      setRevision((value) => value + 1);
    },
    onError: () => {
      if (current) invalidatePlantPhotoUrl(user.uid, photoKey, resolved.url, requestVariant);
      setFailed(true);
    },
  };
}
