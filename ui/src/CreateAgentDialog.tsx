import { useState } from "react";
import { createAgent } from "./api";

interface Props {
  existingIds: string[];
  onClose: () => void;
  onCreated: () => void;
}

export function CreateAgentDialog({ existingIds, onClose, onCreated }: Props) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  function validate(): string | null {
    if (!id.trim()) return "ID is required.";
    if (!/^[a-zA-Z0-9_-]+$/.test(id.trim())) return "ID can only contain letters, numbers, hyphens, and underscores.";
    if (existingIds.includes(id.trim())) return `ID "${id.trim()}" already exists.`;
    if (!name.trim()) return "Name is required.";
    if (!cwd.trim()) return "Working directory is required.";
    return null;
  }

  async function handleCreate() {
    const err = validate();
    if (err) {
      setError(err);
      return;
    }
    setSaving(true);
    setError("");
    const result = await createAgent({
      id: id.trim(),
      name: name.trim(),
      description: description.trim() || `Agent ${name.trim()}`,
      cwd: cwd.trim(),
    });
    setSaving(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    onCreated();
    onClose();
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
        zIndex: 20,
        fontFamily: "system-ui, sans-serif",
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "#181825",
          border: "1px solid #313244",
          borderRadius: 12,
          padding: 24,
          width: 420,
          color: "#cdd6f4",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{ margin: "0 0 16px", fontSize: 18 }}>Add Agent</h2>

        {error && (
          <div style={{ background: "#f38ba822", border: "1px solid #f38ba8", borderRadius: 6, padding: "6px 10px", fontSize: 12, color: "#f38ba8", marginBottom: 12 }}>
            {error}
          </div>
        )}

        <label style={labelStyle}>
          ID <span style={{ color: "#f38ba8" }}>*</span>
        </label>
        <input
          style={inputStyle}
          value={id}
          onChange={(e) => setId(e.target.value)}
          placeholder="my-agent"
          autoFocus
        />

        <label style={labelStyle}>
          Name <span style={{ color: "#f38ba8" }}>*</span>
        </label>
        <input
          style={inputStyle}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Frontend Specialist"
        />

        <label style={labelStyle}>
          Working Directory <span style={{ color: "#f38ba8" }}>*</span>
        </label>
        <input
          style={inputStyle}
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          placeholder="C:\Users\me\projects\frontend"
        />

        <label style={labelStyle}>Description</label>
        <textarea
          style={{ ...inputStyle, height: 80, resize: "vertical" }}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Optional — agent will describe itself on first register"
        />

        <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
          <button
            onClick={handleCreate}
            disabled={saving}
            style={{ ...btnStyle, background: "#a6e3a1", color: "#1e1e2e", flex: 1 }}
          >
            {saving ? "Creating..." : "Create Agent"}
          </button>
          <button onClick={onClose} style={btnStyle}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  color: "#a6adc8",
  marginTop: 12,
  marginBottom: 4,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  background: "#1e1e2e",
  border: "1px solid #313244",
  borderRadius: 6,
  color: "#cdd6f4",
  fontSize: 13,
  boxSizing: "border-box",
};

const btnStyle: React.CSSProperties = {
  padding: "8px 16px",
  background: "#313244",
  border: "none",
  borderRadius: 6,
  color: "#cdd6f4",
  cursor: "pointer",
  fontSize: 13,
};
