import { createContext, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { auth } from '../firebase';
import { clearPlantPhotoCache } from '../services/plantPhotoCache';

export const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => onAuthStateChanged(auth, (currentUser) => {
    clearPlantPhotoCache();
    setUser(currentUser);
    setAuthLoading(false);
  }), []);

  const handleLogout = async () => {
    try {
      await signOut(auth);
      clearPlantPhotoCache();
      navigate('/login');
    } catch (error) {
      console.error('Ошибка выхода:', error);
    }
  };

  return <AuthContext.Provider value={{ user, authLoading, handleLogout }}>{children}</AuthContext.Provider>;
}
