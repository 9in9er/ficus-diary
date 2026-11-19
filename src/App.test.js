import { render, screen } from '@testing-library/react';
import App from './App';
import { useAuth } from './hooks/useAuth';

jest.mock('./hooks/useAuth', () => ({ useAuth: jest.fn() }));
jest.mock('./contexts/AuthContext', () => ({ AuthProvider: ({ children }) => children }));
jest.mock('./components/YandexMetrika', () => () => null);
jest.mock('./components/AuthScreen', () => () => <h1>Вход в аккаунт</h1>);
jest.mock('./components/PlantsPage', () => ({ isWishlist }) => <h1>{isWishlist ? 'Вишлист' : 'Растения'}</h1>);
jest.mock('./components/AccountPage', () => () => <h1>Личный кабинет</h1>);

beforeEach(() => {
  window.history.replaceState({}, '', '/account');
});

test('opens the account route for an authenticated user', () => {
  useAuth.mockReturnValue({ user: { uid: 'user-1' }, authLoading: false });
  render(<App />);
  expect(screen.getByRole('heading', { name: 'Личный кабинет' })).toBeInTheDocument();
});

test('redirects an unauthenticated account visitor to login', () => {
  useAuth.mockReturnValue({ user: null, authLoading: false });
  render(<App />);
  expect(screen.getByRole('heading', { name: 'Вход в аккаунт' })).toBeInTheDocument();
  expect(window.location.pathname).toBe('/login');
});

test('waits for authentication before showing account content', () => {
  useAuth.mockReturnValue({ user: null, authLoading: true });
  render(<App />);
  expect(screen.queryByRole('heading', { name: 'Личный кабинет' })).not.toBeInTheDocument();
  expect(window.location.pathname).toBe('/account');
});

test('opens the wishlist route for an authenticated user', () => {
  window.history.replaceState({}, '', '/wishlist');
  useAuth.mockReturnValue({ user: { uid: 'user-1' }, authLoading: false });
  render(<App />);
  expect(screen.getByRole('heading', { name: 'Вишлист' })).toBeInTheDocument();
});

test('protects the wishlist route for an unauthenticated visitor', () => {
  window.history.replaceState({}, '', '/wishlist');
  useAuth.mockReturnValue({ user: null, authLoading: false });
  render(<App />);
  expect(screen.getByRole('heading', { name: 'Вход в аккаунт' })).toBeInTheDocument();
  expect(window.location.pathname).toBe('/login');
});
