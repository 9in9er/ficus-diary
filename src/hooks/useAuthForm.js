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
  const resetTimer = useRef(null);

  useEffect(() => () => clearTimeout(resetTimer.current), []);

  const handleRegister = async (e) => {
    e.preventDefault();
    setAuthError('');
    try {
      await createUserWithEmailAndPassword(auth, email, password);
      setEmail('');
      setPassword('');
      navigate('/plants');
    } catch (err) {
      if (err.code === 'auth/email-already-in-use') {
        setAuthError('Пользователь с таким email уже существует');
      } else if (err.code === 'auth/invalid-email') {
        setAuthError('Неверный формат email');
      } else if (err.code === 'auth/weak-password') {
        setAuthError('Пароль слишком слабый (минимум 6 символов)');
      } else {
        setAuthError('Ошибка регистрации. Попробуйте позже.');
      }
    }
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setAuthError('');
    try {
      await signInWithEmailAndPassword(auth, email, password);
      setEmail('');
      setPassword('');
      navigate('/plants');
    } catch (err) {
      if (err.code === 'auth/invalid-credential') {
        setAuthError('Неверный email или пароль');
      } else {
        setAuthError('Ошибка входа. Попробуйте позже.' + err.code);
      }
    }
  };

  const handlePasswordReset = async (email) => {
    try {
      await sendPasswordResetEmail(auth, email);
      setResetFeedback({ status: 'success', message: '✅ Ссылка для сброса отправлена на email!' });
      clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => {
        setShowResetModal(false);
        setResetEmail('');
        setResetFeedback(null);
      }, 2000);
    } catch (err) {
      if (err.code === 'auth/user-not-found') {
        setResetFeedback({ status: 'error', message: '❌ Email не найден' });
      } else {
        setResetFeedback({ status: 'error', message: '❌ Ошибка отправки. Попробуйте позже.' });
      }
    }
  }

  return {
    authMode,
    setAuthMode,
    email,
    setEmail,
    password,
    setPassword,
    authError,
    handleLogin,
    handleRegister,
    showResetModal,
    setShowResetModal,
    resetEmail,
    setResetEmail,
    handlePasswordReset,
    resetFeedback,
  };
}
