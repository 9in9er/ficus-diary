import ModalDialog from './ModalDialog';

export default function PasswordResetDialog({ email, onEmailChange, onSubmit, onClose, feedback, isSubmitting }) {
  return (
    <ModalDialog
      className='passwordResetDialog'
      labelledBy='resetPasswordTitle'
      describedBy='resetPasswordHint'
      onClose={onClose}
      isBusy={isSubmitting}
    >
      <form className='resetModal' onSubmit={onSubmit} aria-labelledby='resetPasswordTitle' aria-busy={isSubmitting}>
        <h2 id='resetPasswordTitle'>Сброс пароля</h2>
        <p id='resetPasswordHint'>Введите email — отправим ссылку для сброса.</p>
        <label className='authField' htmlFor='resetEmail'>
          Email для сброса пароля
          <input
            id='resetEmail'
            name='email'
            type='email'
            className='inputLogin'
            placeholder='Email'
            autoComplete='email'
            value={email}
            onChange={(event) => onEmailChange(event.target.value)}
            disabled={isSubmitting}
            required
          />
        </label>
        {feedback && (
          <p className={`resetMessage ${feedback.status}`} role={feedback.status === 'success' ? 'status' : 'alert'}>
            {feedback.message}
          </p>
        )}
        <div className='modalButtons'>
          <button type='submit' className='btn btnSubmit' disabled={isSubmitting || feedback?.status === 'success'}>
            {isSubmitting ? 'Отправляем…' : 'Отправить ссылку'}
          </button>
          <button type='button' className='btn btnCancel' onClick={onClose} disabled={isSubmitting}>Отмена</button>
        </div>
      </form>
    </ModalDialog>
  );
}
