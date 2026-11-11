import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, getToken, setToken, type User } from './api';

interface AuthCtx {
  user: User | null;
  loading: boolean;
  login: (token: string, user: User) => void;
  logout: () => void;
}
const Ctx = createContext<AuthCtx>(null!);
export const useAuth = () => useContext(Ctx);
/** O usuário logado pode fazer isto? (administrador sempre pode; operador depende do que o administrador marcou) */
export const useCan = () => {
  const { user } = useAuth();
  return (perm: string) => !!user && (user.role === 'admin' || (user.permissions ?? []).includes(perm));
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(!!getToken());

  useEffect(() => {
    if (!getToken()) return;
    api<User>('/api/me')
      .then(setUser)
      .catch(() => setToken(null))
      .finally(() => setLoading(false));
  }, []);

  return (
    <Ctx.Provider
      value={{
        user,
        loading,
        login: (t, u) => {
          setToken(t);
          setUser(u);
        },
        logout: () => {
          setToken(null);
          setUser(null);
        },
      }}
    >
      {children}
    </Ctx.Provider>
  );
}
