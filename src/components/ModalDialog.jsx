import { useEffect, useRef } from 'react';
import '../styles/ModalDialog.scss';

export default function ModalDialog({ children, labelledBy, describedBy, onClose, isBusy = false, className = '' }) {
  const dialogRef = useRef(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog.showModal();
    dialog.querySelector('input:not([disabled]), textarea:not([disabled]), button:not([disabled])')?.focus();
    return () => {
      dialog.close();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  const requestClose = () => {
    if (!isBusy) onClose();
  };

  const closeOnBackdrop = (event) => {
    if (event.target !== event.currentTarget) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const outside = event.clientX < bounds.left || event.clientX > bounds.right
      || event.clientY < bounds.top || event.clientY > bounds.bottom;
    if (outside) requestClose();
  };

  return (
    <dialog
      ref={dialogRef}
      className={`modalDialog ${className}`}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onClick={closeOnBackdrop}
      onCancel={(event) => {
        // Отмена выбора файла тоже вызывает cancel, но не должна закрывать диалог.
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        requestClose();
      }}
    >
      {children}
    </dialog>
  );
}
