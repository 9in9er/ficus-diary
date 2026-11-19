const MAX_SIDE = 1600;
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

export function resizePlantPhoto(file) {
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error('Не удалось обработать изображение. Выберите JPG, PNG или WebP до 25 МБ.'));
    if (!file.type.startsWith('image/') || file.size > MAX_SOURCE_BYTES || !file.size) return fail();
    const url = URL.createObjectURL(file);
    const image = new Image();
    const release = () => URL.revokeObjectURL(url);
    image.onerror = () => { release(); fail(); };
    image.onload = () => {
      try {
        if (!image.naturalWidth || !image.naturalHeight) throw new Error('Empty image');
        const ratio = Math.min(1, MAX_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => {
          release();
          if (!blob || blob.type !== 'image/webp' || blob.size > MAX_PHOTO_BYTES) return fail();
          resolve(blob);
        }, 'image/webp', 0.8);
      } catch { release(); fail(); }
    };
    image.src = url;
  });
}
