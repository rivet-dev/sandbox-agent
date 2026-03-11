import { memo } from "react";

export const SkeletonLine = memo(function SkeletonLine({
  width = "100%",
  height = 12,
  borderRadius = 4,
  style,
}: {
  width?: string | number;
  height?: number;
  borderRadius?: number;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        width,
        height,
        borderRadius,
        background: "rgba(255, 255, 255, 0.06)",
        backgroundImage: "linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.04) 50%, rgba(255,255,255,0) 100%)",
        backgroundSize: "200% 100%",
        animation: "hf-shimmer 1.5s ease-in-out infinite",
        flexShrink: 0,
        ...style,
      }}
    />
  );
});

export const SkeletonCircle = memo(function SkeletonCircle({ size = 14, style }: { size?: number; style?: React.CSSProperties }) {
  return <SkeletonLine width={size} height={size} borderRadius={size} style={style} />;
});

export const SkeletonBlock = memo(function SkeletonBlock({
  width = "100%",
  height = 60,
  borderRadius = 8,
  style,
}: {
  width?: string | number;
  height?: number;
  borderRadius?: number;
  style?: React.CSSProperties;
}) {
  return <SkeletonLine width={width} height={height} borderRadius={borderRadius} style={style} />;
});

/** Sidebar skeleton: header + list of task placeholders */
export const SidebarSkeleton = memo(function SidebarSkeleton() {
  return (
    <div style={{ padding: "8px", display: "flex", flexDirection: "column", gap: "4px" }}>
      {/* Repo header skeleton */}
      <div style={{ padding: "10px 8px 4px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <SkeletonLine width="40%" height={10} />
        <SkeletonLine width={48} height={10} />
      </div>
      {/* Task item skeletons */}
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          style={{
            padding: "12px",
            borderRadius: "8px",
            display: "flex",
            flexDirection: "column",
            gap: "8px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <SkeletonCircle size={14} />
            <SkeletonLine width={`${65 - i * 10}%`} height={13} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", paddingLeft: "22px" }}>
            <SkeletonLine width="30%" height={10} />
            <SkeletonLine width={32} height={10} style={{ marginLeft: "auto" }} />
          </div>
        </div>
      ))}
    </div>
  );
});

/** Transcript area skeleton: tab strip + message bubbles */
export const TranscriptSkeleton = memo(function TranscriptSkeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {/* Tab strip skeleton */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "16px",
          height: "41px",
          minHeight: "41px",
          padding: "0 14px",
          borderBottom: "1px solid rgba(255, 255, 255, 0.12)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <SkeletonCircle size={8} />
          <SkeletonLine width={64} height={11} />
        </div>
      </div>
      {/* Message skeletons */}
      <div style={{ padding: "16px 220px 16px 44px", display: "flex", flexDirection: "column", gap: "12px", flex: 1 }}>
        {/* User message */}
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <div style={{ maxWidth: "60%", display: "flex", flexDirection: "column", gap: "6px", alignItems: "flex-end" }}>
            <SkeletonBlock width={240} height={48} borderRadius={16} />
            <SkeletonLine width={60} height={9} />
          </div>
        </div>
        {/* Agent message */}
        <div style={{ display: "flex", justifyContent: "flex-start" }}>
          <div style={{ maxWidth: "70%", display: "flex", flexDirection: "column", gap: "6px", alignItems: "flex-start" }}>
            <SkeletonBlock width={320} height={72} borderRadius={16} />
            <SkeletonLine width={100} height={9} />
          </div>
        </div>
        {/* Another user message */}
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <div style={{ maxWidth: "60%", display: "flex", flexDirection: "column", gap: "6px", alignItems: "flex-end" }}>
            <SkeletonBlock width={180} height={40} borderRadius={16} />
          </div>
        </div>
      </div>
    </div>
  );
});

/** Right sidebar skeleton: status cards + file list */
export const RightSidebarSkeleton = memo(function RightSidebarSkeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {/* Tab bar skeleton */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "16px",
          height: "41px",
          minHeight: "41px",
          padding: "0 16px",
          borderBottom: "1px solid rgba(255, 255, 255, 0.12)",
        }}
      >
        <SkeletonLine width={56} height={11} />
        <SkeletonLine width={48} height={11} />
      </div>
      {/* Status cards */}
      <div style={{ padding: "12px 14px 0", display: "grid", gap: "8px" }}>
        <SkeletonBlock height={52} />
        <SkeletonBlock height={52} />
      </div>
      {/* File changes */}
      <div style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: "4px" }}>
        {[0, 1, 2].map((i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: "8px", padding: "6px 10px" }}>
            <SkeletonCircle size={14} />
            <SkeletonLine width={`${60 - i * 12}%`} height={12} />
            <div style={{ display: "flex", gap: "6px", marginLeft: "auto" }}>
              <SkeletonLine width={24} height={11} />
              <SkeletonLine width={24} height={11} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
});
