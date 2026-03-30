// Catppuccin Mocha palette
export const colors = {
  crust:    "#11111b",
  mantle:   "#181825",
  base:     "#1e1e2e",
  surface0: "#313244",
  surface1: "#45475a",
  overlay0: "#585b70",
  subtext0: "#a6adc8",
  text:     "#cdd6f4",
  blue:     "#89b4fa",
  green:    "#a6e3a1",
  red:      "#f38ba8",
  yellow:   "#f9e2af",
  peach:    "#fab387",
  mauve:    "#cba6f7",
  sapphire: "#74c7ec",
  selected: "#242438",
} as const;

export const fonts = {
  body: "system-ui, sans-serif",
} as const;

export const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  color: colors.subtext0,
  marginTop: 12,
  marginBottom: 4,
};

export const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  background: colors.base,
  border: `1px solid ${colors.surface0}`,
  borderRadius: 6,
  color: colors.text,
  fontSize: 13,
  boxSizing: "border-box",
};

export const btnStyle: React.CSSProperties = {
  padding: "6px 12px",
  background: colors.surface0,
  border: "none",
  borderRadius: 6,
  color: colors.text,
  cursor: "pointer",
  fontSize: 13,
};
