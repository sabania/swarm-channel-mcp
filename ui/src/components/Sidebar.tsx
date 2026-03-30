import { NavLink } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { colors, fonts } from "../theme";

const navItems = [
  { to: "/dashboard", label: "Dashboard", adminOnly: false },
  { to: "/connections", label: "Connections", adminOnly: false },
  { to: "/tasks", label: "Tasks", adminOnly: false },
  { to: "/admin", label: "Topology", adminOnly: true },
];

export function Sidebar() {
  const { isAdmin, isAuthenticated, logout } = useAuth();

  return (
    <div
      style={{
        width: 200,
        minWidth: 200,
        background: colors.mantle,
        borderRight: `1px solid ${colors.surface0}`,
        display: "flex",
        flexDirection: "column",
        fontFamily: fonts.body,
        color: colors.text,
      }}
    >
      {/* Logo */}
      <div style={{ padding: "20px 16px 16px", borderBottom: `1px solid ${colors.surface0}` }}>
        <div style={{ fontSize: 18, fontWeight: 700 }}>Swarm</div>
        <div style={{ fontSize: 11, color: colors.overlay0 }}>Agent Topology Manager</div>
      </div>

      {/* Navigation */}
      <nav style={{ flex: 1, padding: "8px 0" }}>
        {navItems
          .filter((item) => !item.adminOnly || isAdmin)
          .map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              style={({ isActive }) => ({
                display: "block",
                padding: "10px 16px",
                fontSize: 13,
                color: isActive ? colors.blue : colors.subtext0,
                background: isActive ? colors.base : "transparent",
                textDecoration: "none",
                fontWeight: isActive ? 600 : 400,
                borderLeft: isActive ? `3px solid ${colors.blue}` : "3px solid transparent",
              })}
            >
              {item.label}
            </NavLink>
          ))}
      </nav>

      {/* Auth footer */}
      <div style={{ padding: "12px 16px", borderTop: `1px solid ${colors.surface0}`, fontSize: 12 }}>
        <div style={{ color: colors.overlay0, marginBottom: 6 }}>
          {isAuthenticated ? "Authenticated" : "No token"}
        </div>
        {isAuthenticated && (
          <button
            onClick={logout}
            style={{
              background: "none",
              border: "none",
              color: colors.red,
              cursor: "pointer",
              fontSize: 12,
              padding: 0,
            }}
          >
            Logout
          </button>
        )}
      </div>
    </div>
  );
}
