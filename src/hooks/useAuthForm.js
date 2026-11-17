import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { auth } from '../firebase';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
} from 'firebase/auth';

export default function useAuthForm() {
  const [authMode, setAuthMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const navigate = useNavigate();
  const [showResetModal, setShowResetModal] = useState(false);
  const [resetEmail, setResetEmail] = useState('');
  const [resetFeedback, setResetFeedback] = useState(null);
  const [pendingAction, setPendingAction] = useState(null);
  // Блокируем повторный submit ещё до перерисовки кнопок.
  const requestInFlight = useRef(false);
  const resetTimer = useRef(null);

  useEffect(() => () => clearTimeout(resetTimer.current), []);

  const startRequest = (action) => {
    if (requestInFlight.current) return false;
    requestInFlight.current = true;
    setPendingAction(action);
    return true;
  };

  const finishRequest = () => {
    requestInFlight.current = false;
    setPendingAction(null);
  };

  const changeAuthMode = (mode) => {
    if (requestInFlight.current) return;
    setAuthMode(mode);
    setAuthError('');
  };

  const openResetModal = () => {
    if (requestInFlight.current) return;
    clearTimeout(resetTimer.current);
    setResetFeedback(null);
    setShowResetModal(true);
  };

  const closeResetModal = () => {
    if (requestInFlight.current) return;
    clearTimeout(resetTimer.current);
    setShowResetModal(false);
    setResetEmail('');
    setResetFeedback(null);
  };

  const submitAuth = async (event, mode) => {
    event.preventDefault();
    if (!event.currentTarget.reportValidity() || !startRequest(mode)) return;
    setAuthError('');
    try {
      const authenticate = mode === 'login' ? signInWithEmailAndPassword : createUserWithEmailAndPassword;
      await authenticate(auth, email.trim(), password);
      setEmail('');
      setPassword('');
      navigate('/plants');
    } catch (err) {
      if (err.code === 'auth/invalid-credential') {
        setAuthError('Неверный email или пароль');
      } else if (err.code === 'auth/email-already-in-use') {
        setAuthError('Пользователь с таким email уже существует');
      } else if (err.code === 'auth/invalid-email') {
        setAuthError('Неверный формат email');
      } else if (err.code === 'auth/weak-password') {
        setAuthError('Пароль слишком слабый (минимум 6 символов)');
      } else if (err.code === 'auth/network-request-failed') {
        setAuthError('Не удалось подключиться. Проверьте интернет и попробуйте ещё раз.');
      } else if (err.code === 'auth/too-many-requests') {
        setAuthError('Слишком много попыток. Попробуйте позже.');
      } else {
        setAuthError(mode === 'login' ? 'Ошибка входа. Попробуйте позже.' : 'Ошибка регистрации. Попробуйте позже.');
      }
    } finally {
      finishRequest();
    }
  };

  const handlePasswordReset = async (event) => {
    event.preventDefault();
    if (!event.currentTarget.reportValidity() || resetFeedback?.status === 'success' || !startRequest('reset')) return;
    clearTimeout(resetTimer.current);
    setResetFeedback(null);
    try {
      await sendPasswordResetEmail(auth, resetEmail.trim());
      setResetFeedback({ status: 'success', message: '✅ Ссылка для сброса отправлена на email!' });
      resetTimer.current = setTimeout(closeResetModal, 2000);
    } catch (err) {
      if (err.code === 'auth/user-not-found') {
        setResetFeedback({ status: 'error', message: '❌ Email не найден' });
      } else {
        setResetFeedback({ status: 'error', message: '❌ Ошибка отправки. Попробуйте позже.' });
      }
    } finally {
      finishRequest();
    }
  };

  return {
    authMode,
    setAuthMode: changeAuthMode,
    email,
    setEmail,
    password,
    setPassword,
    authError,
    handleLogin: (event) => submitAuth(event, 'login'),
    handleRegister: (event) => submitAuth(event, 'register'),
    isAuthenticating: pendingAction === 'login' || pendingAction === 'register',
    showResetModal,
    openResetModal,
    closeResetModal,
    resetEmail,
    setResetEmail,
    handlePasswordReset,
    resetFeedback,
    isResetting: pendingAction === 'reset',
  };
}
