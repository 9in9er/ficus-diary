export default function CardSavingOverlay() {
  return (
    <div className='cardSavingOverlay' role='status' aria-live='polite'>
      <span className='cardSavingSpinner' aria-hidden='true' />
      <span>Сохраняем изменения…</span>
    </div>
  );
}
