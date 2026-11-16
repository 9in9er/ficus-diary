import './styles/Base.scss';
import './styles/App.scss';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import AuthScreen from './components/AuthScreen';
import PlantsPage from './components/PlantsPage';
import AccountPage from './components/AccountPage';
import { AuthProvider } from './contexts/AuthContext';
import AuthGuard from './components/AuthGuard';
import YandexMetrika from './components/YandexMetrika';

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <YandexMetrika />
        <Routes>
          <Route path='/login' element={<AuthScreen />} />
          <Route
            path='/plants'
            element={
              <AuthGuard>
                <PlantsPage />
              </AuthGuard>
            }
          />
          <Route
            path='/account'
            element={
              <AuthGuard>
                <AccountPage />
              </AuthGuard>
            }
          />
          <Route path='/' element={<Navigate to='/plants' replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
