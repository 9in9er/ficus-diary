const PHOTO_WIDTH = 150;

export function resizePlantPhoto(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const fail = () => reject(new Error('Не удалось обработать изображение.'));
    reader.onerror = fail;
    reader.onload = () => {
      const image = new Image();
      image.onerror = fail;
      image.onload = () => {
        if (!image.width) return fail();
        const canvas = document.createElement('canvas');
        canvas.width = PHOTO_WIDTH;
        canvas.height = image.height * PHOTO_WIDTH / image.width;
        try {
          const context = canvas.getContext('2d');
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.8));
        } catch {
          fail();
        }
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
