import { createContext, useContext, useEffect, useRef, useState } from "react";
import { getAdminToken, setAdminToken, clearAdminToken, setOnAuthRequired } from "../api";
import { AuthDialog } from "../AuthDialog";

interface AuthState {
  token: string | null;
  isAdmin: boolean;
  isAuthenticated: boolean;
  login: (token: string) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthState>({
  token: null,
  isAdmin: false,
  isAuthenticated: false,
  login: () => {},
  logout: () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(getAdminToken);
  const [showAuthDialog, setShowAuthDialog] = useState(false);
  const authResolveRef = useRef<(() => void) | null>(null);

  function login(newToken: string) {
    setAdminToken(newToken);
    setToken(newToken);
  }

  function logout() {
    clearAdminToken();
    setToken(null);
  }

  useEffect(() => {
    setOnAuthRequired(() => new Promise<void>((resolve) => {
      authResolveRef.current = resolve;
      setShowAuthDialog(true);
    }));
    return () => setOnAuthRequired(null);
  }, []);

  const value: AuthState = {
    token,
    isAdmin: !!token,
    isAuthenticated: !!token,
    login,
    logout,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
      {showAuthDialog && (
        <AuthDialog
          onSubmit={(t) => {
            login(t);
            setShowAuthDialog(false);
            authResolveRef.current?.();
          }}
          onCancel={() => {
            setShowAuthDialog(false);
            authResolveRef.current?.();
          }}
        />
      )}
    </AuthContext.Provider>
  );
}
