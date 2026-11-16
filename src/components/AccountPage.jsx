import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword,
} from 'firebase/auth';
import { auth } from '../firebase';
import { useAuth } from '../hooks/useAuth';
import Header from './Header';
import Footer from './Footer';
import '../styles/AccountPage.scss';

function getPasswordError(error) {
  switch (error.code) {
    case 'auth/wrong-password':
    case 'auth/invalid-credential':
      return 'Неверный старый пароль. Попробуйте ещё раз.';
    case 'auth/weak-password':
    case 'auth/password-does-not-meet-requirements':
      return 'Новый пароль слишком простой. Используйте не менее 6 символов, заглавные и строчные буквы, цифры и специальные символы.';
    case 'auth/too-many-requests':
      return 'Слишком много попыток. Попробуйте позже.';
    case 'auth/network-request-failed':
      return 'Не удалось подключиться. Проверьте интернет и попробуйте ещё раз.';
    case 'auth/requires-recent-login':
      return 'Время проверки истекло. Введите старый пароль ещё раз.';
    default:
      return 'Не удалось изменить пароль. Попробуйте ещё раз.';
  }
}

function AccountPage() {
  const { user, handleLogout } = useAuth();
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [verifiedUser, setVerifiedUser] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const passwordInput = useRef(null);

  useEffect(() => {
    passwordInput.current?.focus();
  }, [verifiedUser]);

  const resetForm = () => {
    setOldPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setVerifiedUser(null);
    setError('');
    setSuccess('');
  };

  const verifyOldPassword = async (event) => {
    event.preventDefault();
    if (isSubmitting) return;
    setError('');
    setSuccess('');

    const currentUser = auth.currentUser;
    if (!currentUser?.email) {
      setError('Сессия истекла. Войдите в аккаунт ещё раз.');
      return;
    }
    if (!oldPassword) {
      setError('Введите старый пароль.');
      return;
    }

    setIsSubmitting(true);
    try {
      const credential = EmailAuthProvider.credential(currentUser.email, oldPassword);
      await reauthenticateWithCredential(currentUser, credential);
      if (auth.currentUser !== currentUser) {
        setError('Аккаунт изменился. Введите старый пароль ещё раз.');
        return;
      }
      setOldPassword('');
      setVerifiedUser(currentUser);
    } catch (err) {
      setError(getPasswordError(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const saveNewPassword = async (event) => {
    event.preventDefault();
    if (isSubmitting) return;
    setError('');
    setSuccess('');

    if (!verifiedUser || auth.currentUser !== verifiedUser) {
      resetForm();
      setError('Введите старый пароль ещё раз.');
      return;
    }
    if (newPassword.length < 6) {
      setError('Новый пароль должен содержать не менее 6 символов.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Новые пароли не совпадают.');
      return;
    }

    setIsSubmitting(true);
    try {
      await updatePassword(verifiedUser, newPassword);
      resetForm();
      setSuccess('Пароль успешно изменён.');
    } catch (err) {
      if (err.code === 'auth/requires-recent-login') resetForm();
      setError(getPasswordError(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <div className='mainBlock accountPage'>
        <div className='pageHeader'>
          <Header showCount={false} />
          <button type='button' className='btn btnCancel' onClick={handleLogout} disabled={isSubmitting}>
            Выйти
          </button>
        </div>

        <Link className='accountBackLink' to='/plants'>← К растениям</Link>

        <main className='accountPanel'>
          <h1>Личный кабинет</h1>
          {user?.email && <p className='accountEmail'>{user.email}</p>}

          <form className='passwordForm' onSubmit={verifiedUser ? saveNewPassword : verifyOldPassword} aria-labelledby='passwordFormTitle' aria-busy={isSubmitting}>
            <h2 id='passwordFormTitle'>Смена пароля</h2>
            <p className='passwordHint'>
              {verifiedUser
                ? 'Старый пароль подтверждён. Введите новый пароль.'
                : 'Сначала введите старый пароль, чтобы подтвердить смену.'}
            </p>

            {!verifiedUser ? (
              <div className='passwordField'>
                <label htmlFor='oldPassword'>Старый пароль</label>
                <input
                  ref={passwordInput}
                  id='oldPassword'
                  name='currentPassword'
                  type='password'
                  autoComplete='current-password'
                  value={oldPassword}
                  onChange={(event) => setOldPassword(event.target.value)}
                  disabled={isSubmitting}
                  required
                />
              </div>
            ) : (
              <>
                <div className='passwordField'>
                  <label htmlFor='newPassword'>Новый пароль</label>
                  <input
                    ref={passwordInput}
                    id='newPassword'
                    name='newPassword'
                    type='password'
                    autoComplete='new-password'
                    aria-describedby='newPasswordHint'
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.target.value)}
                    disabled={isSubmitting}
                    minLength={6}
                    required
                  />
                  <small id='newPasswordHint'>Не менее 6 символов.</small>
                </div>
                <div className='passwordField'>
                  <label htmlFor='confirmPassword'>Повторите новый пароль</label>
                  <input
                    id='confirmPassword'
                    name='confirmPassword'
                    type='password'
                    autoComplete='new-password'
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    disabled={isSubmitting}
                    minLength={6}
                    required
                  />
                </div>
              </>
            )}

            {error && <p className='passwordError' role='alert'>{error}</p>}
            {success && <p className='passwordSuccess' role='status'>{success}</p>}

            <div className='passwordActions'>
              <button type='submit' className='btn btnSubmit' disabled={isSubmitting}>
                {isSubmitting
                  ? (verifiedUser ? 'Сохраняем…' : 'Проверяем…')
                  : (verifiedUser ? 'Сохранить пароль' : 'Продолжить')}
              </button>
              {verifiedUser && (
                <button type='button' className='btn btnToggle' onClick={resetForm} disabled={isSubmitting}>
                  Отмена
                </button>
              )}
            </div>
          </form>
        </main>
      </div>
      <Footer />
    </>
  );
}

export default AccountPage;
