import { useLayoutEffect, useRef } from 'react';

export default function useAutoResizeTextarea(text, isEditing, isTrash) {
  const inputRef = useRef(null);

  useLayoutEffect(() => {
    const textarea = inputRef.current;
    if (!textarea) return;

    const resize = () => {
      textarea.style.height = 'auto';
      const borderHeight = textarea.offsetHeight - textarea.clientHeight;
      textarea.style.height = `${textarea.scrollHeight + borderHeight}px`;
    };
    resize();

    let resizeFrame = null;
    let previousWidth = textarea.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const width = textarea.getBoundingClientRect().width;
      if (width !== previousWidth) {
        previousWidth = width;
        // Ждём завершения уведомлений observer, чтобы избежать цикла resize.
        cancelAnimationFrame(resizeFrame);
        resizeFrame = requestAnimationFrame(resize);
      }
    });
    observer.observe(textarea);

    return () => {
      observer.disconnect();
      cancelAnimationFrame(resizeFrame);
    };
  }, [text, isEditing, isTrash]);

  return inputRef;
}
