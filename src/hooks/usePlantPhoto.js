import { useEffect, useState } from 'react';
import { useAuth } from './useAuth';
import { photoRequest } from '../services/plantPhotos';
import { isHttpPhotoUrl } from '../utils/photoUrl';

export default function usePlantPhoto(plant) {
  const { user } = useAuth();
  const [resolved, setResolved] = useState(null);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => { setFailed(false); }, [plant.photo, plant.photoKey]);
  useEffect(() => {
    if (!plant.photoKey || !user) return undefined;
    let cancelled = false;
    let timer;
    setFailed(false);
    const refresh = async () => {
      try {
        const result = await photoRequest(user, { action: 'read', plantId: plant.id });
        if (cancelled) return;
        setResolved({ uid: user.uid, key: plant.photoKey, url: result.url });
        setFailed(false);
        timer = setTimeout(refresh, Math.max(30, (result.expiresIn || 600) - 60) * 1000);
      } catch {
        if (cancelled) return;
        setFailed(true);
        timer = setTimeout(refresh, 30000);
      }
    };
    refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [plant.id, plant.photoKey, user, revision]);

  const current = resolved?.uid === user?.uid && resolved?.key === plant.photoKey;
  return {
    src: plant.photoKey
      ? ((current && !failed && resolved.url) || null)
      : (isHttpPhotoUrl(plant.photo) ? plant.photo : null),
    failed,
    revision,
    retry: () => { setFailed(false); setRevision((value) => value + 1); },
    onError: () => setFailed(true),
  };
}
