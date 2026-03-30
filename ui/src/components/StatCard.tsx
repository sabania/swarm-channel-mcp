import { colors, fonts } from "../theme";

interface Props {
  title: string;
  value: string | number;
  subtitle?: string;
  accentColor: string;
}

export function StatCard({ title, value, subtitle, accentColor }: Props) {
  return (
    <div
      style={{
        background: colors.base,
        border: `1px solid ${colors.surface0}`,
        borderLeft: `3px solid ${accentColor}`,
        borderRadius: 12,
        padding: "16px 20px",
        fontFamily: fonts.body,
        flex: 1,
        minWidth: 140,
      }}
    >
      <div style={{ fontSize: 11, color: colors.overlay0, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>
        {title}
      </div>
      <div style={{ fontSize: 28, fontWeight: 700, color: colors.text, lineHeight: 1 }}>
        {value}
      </div>
      {subtitle && (
        <div style={{ fontSize: 12, color: colors.subtext0, marginTop: 4 }}>
          {subtitle}
        </div>
      )}
    </div>
  );
}
