import '../styles/AuthScreen.scss';

import Header from './Header';
import PasswordResetDialog from './PasswordResetDialog';

import useAuthForm from '../hooks/useAuthForm';

function AuthScreen() {
  const {
    authMode,
    setAuthMode,
    email,
    setEmail,
    password,
    setPassword,
    authError,
    handleLogin,
    handleRegister,
    isAuthenticating,
    showResetModal,
    openResetModal,
    closeResetModal,
    resetEmail,
    setResetEmail,
    handlePasswordReset,
    resetFeedback,
    isResetting,
  } = useAuthForm();

  const isLogin = authMode === 'login';

  return (
    <div className='mainBlock'>
      <Header showCount={false} />

      <div className="authScreen">
        {showResetModal && (
          <PasswordResetDialog
            email={resetEmail}
            onEmailChange={setResetEmail}
            onSubmit={handlePasswordReset}
            onClose={closeResetModal}
            feedback={resetFeedback}
            isSubmitting={isResetting}
          />
        )}
        <form className='authForm' onSubmit={isLogin ? handleLogin : handleRegister} aria-labelledby='authFormTitle' aria-busy={isAuthenticating}>
          <h1 className='appTitle' id='authFormTitle'>
            {isLogin ? 'Вход в аккаунт' : 'Регистрация'}
          </h1>

          <label className='authField' htmlFor='authEmail'>
            Email
            <input
              id='authEmail'
              name='email'
              type='email'
              className='inputLogin'
              placeholder='Email'
              autoComplete='username'
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={isAuthenticating}
              required
            />
          </label>

          <label className='authField' htmlFor='authPassword'>
            Пароль
            <input
              id='authPassword'
              name='password'
              type='password'
              className='inputPass'
              placeholder='Пароль'
              autoComplete={isLogin ? 'current-password' : 'new-password'}
              minLength={isLogin ? undefined : 6}
              aria-describedby={isLogin ? undefined : 'authPasswordHint'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={isAuthenticating}
              required
            />
          </label>
          {!isLogin && <small id='authPasswordHint'>Не менее 6 символов.</small>}

          {authError && <div className='authError' role='alert'>{authError}</div>}

          <button type='submit' className='btn btnSubmit' disabled={isAuthenticating}>
            {isAuthenticating ? (isLogin ? 'Входим…' : 'Регистрируем…') : (isLogin ? 'Войти' : 'Зарегистрироваться')}
          </button>

          <div className="authToggle">
            {isLogin ? (
              <>
                <span>Ещё не зарегистрированы?</span>
                <button
                  type="button"
                  className="btn btnToggle"
                  onClick={() => setAuthMode('register')}
                  disabled={isAuthenticating}
                >
                  Зарегистрироваться
                </button>
              </>
            ) : (
              <>
                <span>Уже есть аккаунт?</span>
                <button
                  type="button"
                  className="btn btnToggle"
                  onClick={() => setAuthMode('login')}
                  disabled={isAuthenticating}
                >
                  Войти
                </button>
              </>
            )}
          </div>
        </form>

        {isLogin && (
          <div className='forgotPassword'>
            <button 
              className='forgotPasswordLink'
              type='button'
              onClick={openResetModal}
              disabled={isAuthenticating}
            >Забыли пароль?</button>
          </div>
        )}
      </div>
    </div>
  );
}

export default AuthScreen;
