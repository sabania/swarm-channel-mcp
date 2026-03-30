import { useState } from "react";

interface Props {
  onSubmit: (token: string) => void;
  onCancel: () => void;
}

export function AuthDialog({ onSubmit, onCancel }: Props) {
  const [token, setToken] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (token.trim()) onSubmit(token.trim());
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 30,
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <form
        onSubmit={handleSubmit}
        style={{
          background: "#181825",
          border: "1px solid #313244",
          borderRadius: 12,
          padding: 24,
          width: 400,
          color: "#cdd6f4",
        }}
      >
        <h2 style={{ margin: "0 0 8px", fontSize: 18 }}>Admin Token Required</h2>
        <p style={{ fontSize: 13, color: "#a6adc8", margin: "0 0 16px" }}>
          The service requires authentication. Enter the admin token shown in the service console.
        </p>

        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Paste admin token here"
          autoFocus
          style={{
            width: "100%",
            padding: "8px 10px",
            background: "#1e1e2e",
            border: "1px solid #313244",
            borderRadius: 6,
            color: "#cdd6f4",
            fontSize: 13,
            boxSizing: "border-box",
          }}
        />

        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button
            type="submit"
            disabled={!token.trim()}
            style={{
              flex: 1,
              padding: "8px 16px",
              background: token.trim() ? "#89b4fa" : "#45475a",
              border: "none",
              borderRadius: 6,
              color: "#1e1e2e",
              cursor: token.trim() ? "pointer" : "default",
              fontSize: 13,
              fontWeight: "bold",
            }}
          >
            Authenticate
          </button>
          <button
            type="button"
            onClick={onCancel}
            style={{
              padding: "8px 16px",
              background: "#313244",
              border: "none",
              borderRadius: 6,
              color: "#cdd6f4",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
