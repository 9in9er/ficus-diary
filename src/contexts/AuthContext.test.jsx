import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { AuthProvider } from './AuthContext';
import { useAuth } from '../hooks/useAuth';

jest.mock('../firebase', () => ({ auth: {} }));
jest.mock('firebase/auth', () => ({ onAuthStateChanged: jest.fn(), signOut: jest.fn() }));

function UserStatus({ label }) {
  const { user, authLoading } = useAuth();
  return <p>{label}: {authLoading ? 'loading' : user?.email || 'guest'}</p>;
}

function Logout() {
  const { handleLogout } = useAuth();
  const location = useLocation();
  return <><button onClick={handleLogout}>Logout</button><p>{location.pathname}</p></>;
}

beforeEach(() => {
  jest.resetAllMocks();
  onAuthStateChanged.mockReturnValue(jest.fn());
  signOut.mockResolvedValue();
});

test('shares one authentication subscription between consumers and cleans it up', () => {
  const unsubscribe = jest.fn();
  onAuthStateChanged.mockReturnValue(unsubscribe);
  const { unmount } = render(
    <MemoryRouter><AuthProvider><UserStatus label='A' /><UserStatus label='B' /></AuthProvider></MemoryRouter>
  );
  expect(screen.getByText('A: loading')).toBeInTheDocument();
  expect(onAuthStateChanged).toHaveBeenCalledTimes(1);
  act(() => onAuthStateChanged.mock.calls[0][1]({ uid: 'user-1', email: 'plant@example.com' }));
  expect(screen.getByText('A: plant@example.com')).toBeInTheDocument();
  expect(screen.getByText('B: plant@example.com')).toBeInTheDocument();
  act(() => onAuthStateChanged.mock.calls[0][1](null));
  expect(screen.getByText('A: guest')).toBeInTheDocument();
  expect(screen.getByText('B: guest')).toBeInTheDocument();
  unmount();
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});

test('navigates to login after signing out', async () => {
  render(<MemoryRouter initialEntries={['/account']}><AuthProvider><Logout /></AuthProvider></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'Logout' }));
  expect(await screen.findByText('/login')).toBeInTheDocument();
  expect(signOut).toHaveBeenCalledTimes(1);
});
