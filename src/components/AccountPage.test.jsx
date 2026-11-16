import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { EmailAuthProvider, reauthenticateWithCredential, updatePassword } from 'firebase/auth';
import { auth } from '../firebase';
import { useAuth } from '../hooks/useAuth';
import AccountPage from './AccountPage';

jest.mock('../firebase', () => ({ auth: { currentUser: null } }));
jest.mock('../hooks/useAuth', () => ({ useAuth: jest.fn() }));
jest.mock('firebase/auth', () => ({
  EmailAuthProvider: { credential: jest.fn() },
  reauthenticateWithCredential: jest.fn(),
  updatePassword: jest.fn(),
}));

const currentUser = { uid: 'user-1', email: 'plant@example.com' };
const logout = jest.fn();

beforeEach(() => {
  jest.resetAllMocks();
  auth.currentUser = currentUser;
  useAuth.mockReturnValue({ user: currentUser, handleLogout: logout });
  EmailAuthProvider.credential.mockReturnValue({ providerId: 'password' });
  reauthenticateWithCredential.mockResolvedValue({ user: currentUser });
  updatePassword.mockResolvedValue();
});

function renderAccount() {
  render(<MemoryRouter><AccountPage /></MemoryRouter>);
}

function submitForm() {
  fireEvent.submit(screen.getByRole('form', { name: 'Смена пароля' }));
}

async function verifyPassword() {
  fireEvent.change(screen.getByLabelText('Старый пароль'), { target: { value: 'old-password' } });
  submitForm();
  await screen.findByLabelText('Новый пароль');
}

function enterNewPassword(password = 'new-password', confirmation = password) {
  fireEvent.change(screen.getByLabelText('Новый пароль'), { target: { value: password } });
  fireEvent.change(screen.getByLabelText('Повторите новый пароль'), { target: { value: confirmation } });
}

test('keeps the new password hidden until Firebase verifies the old password', async () => {
  renderAccount();
  let finishVerification;
  reauthenticateWithCredential.mockImplementation(() => new Promise((resolve) => { finishVerification = resolve; }));
  expect(screen.queryByLabelText('Новый пароль')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Старый пароль'), { target: { value: 'old-password' } });
  submitForm();
  expect(screen.getByRole('button', { name: 'Проверяем…' })).toBeDisabled();
  expect(screen.queryByLabelText('Новый пароль')).not.toBeInTheDocument();
  expect(updatePassword).not.toHaveBeenCalled();

  await act(async () => finishVerification({ user: currentUser }));
  expect(EmailAuthProvider.credential).toHaveBeenCalledWith(currentUser.email, 'old-password');
  expect(reauthenticateWithCredential).toHaveBeenCalledWith(currentUser, { providerId: 'password' });
  expect(screen.getByLabelText('Новый пароль')).toHaveFocus();
});

test.each(['auth/wrong-password', 'auth/invalid-credential'])(
  'rejects an incorrect old password (%s)',
  async (code) => {
  renderAccount();
    reauthenticateWithCredential.mockRejectedValue({ code });
    fireEvent.change(screen.getByLabelText('Старый пароль'), { target: { value: 'wrong' } });
    submitForm();
    expect(await screen.findByRole('alert')).toHaveTextContent('Неверный старый пароль');
    expect(screen.queryByLabelText('Новый пароль')).not.toBeInTheDocument();
    expect(updatePassword).not.toHaveBeenCalled();
  }
);

test('saves a confirmed new password and clears all password fields', async () => {
  renderAccount();
  await verifyPassword();
  enterNewPassword();
  submitForm();
  expect(await screen.findByRole('status')).toHaveTextContent('Пароль успешно изменён.');
  expect(updatePassword).toHaveBeenCalledWith(currentUser, 'new-password');
  expect(screen.getByLabelText('Старый пароль')).toHaveValue('');
  expect(screen.queryByLabelText('Новый пароль')).not.toBeInTheDocument();
});

test.each([
  ['short', 'short', 'не менее 6 символов'],
  ['new-password', 'different-password', 'не совпадают'],
])('does not save invalid new passwords', async (password, confirmation, message) => {
  renderAccount();
  await verifyPassword();
  enterNewPassword(password, confirmation);
  submitForm();
  expect(screen.getByRole('alert')).toHaveTextContent(message);
  expect(updatePassword).not.toHaveBeenCalled();
});

test('cancelling clears passwords and requires the old password again', async () => {
  renderAccount();
  await verifyPassword();
  enterNewPassword();
  fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
  expect(screen.getByLabelText('Старый пароль')).toHaveValue('');
  expect(screen.queryByLabelText('Новый пароль')).not.toBeInTheDocument();
  await verifyPassword();
  expect(screen.getByLabelText('Новый пароль')).toHaveValue('');
  expect(screen.getByLabelText('Повторите новый пароль')).toHaveValue('');
  expect(updatePassword).not.toHaveBeenCalled();
});

test('requires verification again when Firebase rejects an expired verification', async () => {
  renderAccount();
  await verifyPassword();
  updatePassword.mockRejectedValue({ code: 'auth/requires-recent-login' });
  enterNewPassword();
  submitForm();
  expect(await screen.findByRole('alert')).toHaveTextContent('Время проверки истекло');
  expect(screen.getByLabelText('Старый пароль')).toHaveValue('');
  expect(screen.queryByLabelText('Новый пароль')).not.toBeInTheDocument();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

test('does not save for another account if the active user changes', async () => {
  renderAccount();
  await verifyPassword();
  auth.currentUser = { uid: 'user-2', email: 'other@example.com' };
  enterNewPassword();
  submitForm();
  expect(screen.getByRole('alert')).toHaveTextContent('Введите старый пароль ещё раз');
  expect(updatePassword).not.toHaveBeenCalled();
});

test('allows retrying after a network error without claiming success', async () => {
  renderAccount();
  await verifyPassword();
  updatePassword.mockRejectedValueOnce({ code: 'auth/network-request-failed' });
  enterNewPassword();
  submitForm();
  expect(await screen.findByRole('alert')).toHaveTextContent('Проверьте интернет');
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Сохранить пароль' })).toBeEnabled());
  submitForm();
  expect(await screen.findByRole('status')).toHaveTextContent('Пароль успешно изменён.');
});

test('provides a return link and account logout', () => {
  renderAccount();
  expect(screen.getByRole('link', { name: '← К растениям' })).toHaveAttribute('href', '/plants');
  fireEvent.click(screen.getByRole('button', { name: 'Выйти' }));
  expect(logout).toHaveBeenCalledTimes(1);
});
