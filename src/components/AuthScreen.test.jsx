import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createUserWithEmailAndPassword, sendPasswordResetEmail, signInWithEmailAndPassword } from 'firebase/auth';
import { auth } from '../firebase';
import AuthScreen from './AuthScreen';

jest.mock('../firebase', () => ({ auth: {} }));
jest.mock('firebase/auth', () => ({
  createUserWithEmailAndPassword: jest.fn(),
  sendPasswordResetEmail: jest.fn(),
  signInWithEmailAndPassword: jest.fn(),
}));

beforeEach(() => {
  jest.resetAllMocks();
  signInWithEmailAndPassword.mockResolvedValue();
  createUserWithEmailAndPassword.mockResolvedValue();
  sendPasswordResetEmail.mockResolvedValue();
});

afterEach(() => jest.useRealTimers());

function renderAuth() {
  render(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path='/login' element={<AuthScreen />} />
        <Route path='/plants' element={<h1>Растения</h1>} />
      </Routes>
    </MemoryRouter>
  );
}

function enterCredentials() {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'plant@example.com' } });
  fireEvent.change(screen.getByLabelText('Пароль'), { target: { value: 'plant-password' } });
}

function openReset() {
  const trigger = screen.getByRole('button', { name: 'Забыли пароль?' });
  trigger.focus();
  fireEvent.click(trigger);
  return screen.getByRole('form', { name: 'Сброс пароля' });
}

function cancelDialog() {
  fireEvent(screen.getByRole('dialog', { name: 'Сброс пароля' }), new Event('cancel', { cancelable: true }));
}

function deferredRequest() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

test('labels fields and uses the appropriate password autocomplete in each mode', () => {
  renderAuth();
  expect(screen.getByLabelText('Email')).toHaveAttribute('autocomplete', 'username');
  expect(screen.getByLabelText('Пароль')).toHaveAttribute('autocomplete', 'current-password');
  fireEvent.click(screen.getByRole('button', { name: 'Зарегистрироваться' }));
  expect(screen.getByLabelText('Пароль')).toHaveAttribute('autocomplete', 'new-password');
  expect(screen.getByLabelText('Пароль')).toHaveAttribute('minlength', '6');
});

test.each([
  ['login', signInWithEmailAndPassword, 'Входим…', 'Вход в аккаунт'],
  ['register', createUserWithEmailAndPassword, 'Регистрируем…', 'Регистрация'],
])('blocks duplicate %s requests and navigates only after success', async (mode, authenticate, pendingLabel, formName) => {
  const request = deferredRequest();
  authenticate.mockReturnValueOnce(request.promise);
  renderAuth();
  if (mode === 'register') fireEvent.click(screen.getByRole('button', { name: 'Зарегистрироваться' }));
  enterCredentials();
  const form = screen.getByRole('form', { name: formName });
  fireEvent.submit(form);
  expect(screen.getByRole('button', { name: pendingLabel })).toBeDisabled();
  expect(screen.getByLabelText('Email')).toBeDisabled();
  expect(screen.getByLabelText('Пароль')).toBeDisabled();
  fireEvent.submit(form);
  expect(authenticate).toHaveBeenCalledTimes(1);
  expect(authenticate).toHaveBeenCalledWith(auth, 'plant@example.com', 'plant-password');
  expect(screen.queryByRole('heading', { name: 'Растения' })).not.toBeInTheDocument();
  await act(async () => request.resolve());
  expect(screen.getByRole('heading', { name: 'Растения' })).toBeInTheDocument();
});

test('rejects incomplete credentials before calling Firebase', () => {
  renderAuth();
  fireEvent.submit(screen.getByRole('form', { name: 'Вход в аккаунт' }));
  expect(signInWithEmailAndPassword).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Email')).toBeInvalid();
});

test('preserves credentials after an error and allows retrying', async () => {
  signInWithEmailAndPassword.mockRejectedValueOnce({ code: 'auth/network-request-failed' });
  renderAuth();
  enterCredentials();
  fireEvent.submit(screen.getByRole('form', { name: 'Вход в аккаунт' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Проверьте интернет');
  expect(screen.getByLabelText('Email')).toHaveValue('plant@example.com');
  expect(screen.getByLabelText('Пароль')).toHaveValue('plant-password');
  expect(screen.getByRole('button', { name: 'Войти' })).toBeEnabled();
  fireEvent.submit(screen.getByRole('form', { name: 'Вход в аккаунт' }));
  expect(await screen.findByRole('heading', { name: 'Растения' })).toBeInTheDocument();
  expect(signInWithEmailAndPassword).toHaveBeenCalledTimes(2);
});

test('clears the old error when changing modes and does not show raw error codes', async () => {
  signInWithEmailAndPassword.mockRejectedValueOnce({ code: 'auth/internal-error' });
  renderAuth();
  enterCredentials();
  fireEvent.submit(screen.getByRole('form', { name: 'Вход в аккаунт' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Ошибка входа. Попробуйте позже.');
  expect(screen.getByRole('alert')).not.toHaveTextContent('auth/internal-error');
  fireEvent.click(screen.getByRole('button', { name: 'Зарегистрироваться' }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('focuses the reset email and restores focus after Escape', () => {
  renderAuth();
  openReset();
  expect(screen.getByLabelText('Email для сброса пароля')).toHaveFocus();
  expect(screen.getByLabelText('Email для сброса пароля')).toHaveAttribute('autocomplete', 'email');
  cancelDialog();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Забыли пароль?' })).toHaveFocus();
});

test('closes on the backdrop and keeps clicks inside the form open', () => {
  renderAuth();
  const form = openReset();
  fireEvent.click(form);
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('dialog'), { clientX: 10, clientY: 10 });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Забыли пароль?' })).toHaveFocus();
});

test.each(['', 'invalid-email'])('does not send a reset request for invalid email: %s', (email) => {
  renderAuth();
  const form = openReset();
  fireEvent.change(screen.getByLabelText('Email для сброса пароля'), { target: { value: email } });
  fireEvent.submit(form);
  expect(screen.getByLabelText('Email для сброса пароля')).toBeInvalid();
  expect(sendPasswordResetEmail).not.toHaveBeenCalled();
});

test('blocks duplicate reset requests and keeps the dialog open while sending', async () => {
  const request = deferredRequest();
  sendPasswordResetEmail.mockReturnValueOnce(request.promise);
  renderAuth();
  const form = openReset();
  fireEvent.change(screen.getByLabelText('Email для сброса пароля'), { target: { value: 'plant@example.com' } });
  fireEvent.submit(form);
  expect(screen.getByRole('button', { name: 'Отправляем…' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Отмена' })).toBeDisabled();
  expect(screen.getByLabelText('Email для сброса пароля')).toBeDisabled();
  fireEvent.submit(form);
  cancelDialog();
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(sendPasswordResetEmail).toHaveBeenCalledTimes(1);
  await act(async () => request.resolve());
  expect(screen.getByRole('status')).toHaveTextContent('Ссылка для сброса отправлена');
  expect(screen.getByRole('button', { name: 'Отправить ссылку' })).toBeDisabled();
});

test('preserves the reset email after a failed request and allows retrying', async () => {
  sendPasswordResetEmail.mockRejectedValueOnce({ code: 'auth/network-request-failed' });
  renderAuth();
  const form = openReset();
  fireEvent.change(screen.getByLabelText('Email для сброса пароля'), { target: { value: 'plant@example.com' } });
  fireEvent.submit(form);
  expect(await screen.findByRole('alert')).toHaveTextContent('Ошибка отправки');
  expect(screen.getByLabelText('Email для сброса пароля')).toHaveValue('plant@example.com');
  expect(screen.getByRole('button', { name: 'Отправить ссылку' })).toBeEnabled();
  fireEvent.submit(form);
  expect(await screen.findByRole('status')).toHaveTextContent('Ссылка для сброса отправлена');
  expect(sendPasswordResetEmail).toHaveBeenCalledTimes(2);
  expect(sendPasswordResetEmail).toHaveBeenLastCalledWith(auth, 'plant@example.com');
});

test('closes after a successful reset and restores focus', async () => {
  jest.useFakeTimers();
  renderAuth();
  const form = openReset();
  fireEvent.change(screen.getByLabelText('Email для сброса пароля'), { target: { value: 'plant@example.com' } });
  fireEvent.submit(form);
  expect(await screen.findByRole('status')).toHaveTextContent('Ссылка для сброса отправлена');
  act(() => jest.advanceTimersByTime(2000));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Забыли пароль?' })).toHaveFocus();
});

test('clears feedback and cancels the old timer when reopening the dialog', async () => {
  jest.useFakeTimers();
  renderAuth();
  const form = openReset();
  fireEvent.change(screen.getByLabelText('Email для сброса пароля'), { target: { value: 'plant@example.com' } });
  fireEvent.submit(form);
  await screen.findByRole('status');
  fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
  openReset();
  act(() => jest.advanceTimersByTime(2000));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Email для сброса пароля')).toHaveValue('');
});
