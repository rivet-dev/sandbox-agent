import { memo, useState } from "react";
import { useStyletron } from "baseui";
import { StatefulPopover, PLACEMENT } from "baseui/popover";
import { ChevronDown, Star } from "lucide-react";

import { AgentIcon } from "./ui";
import { MODEL_GROUPS, modelLabel, providerAgent, type ModelId } from "./view-model";

const ModelPickerContent = memo(function ModelPickerContent({
  value,
  defaultModel,
  onChange,
  onSetDefault,
  close,
}: {
  value: ModelId;
  defaultModel: ModelId;
  onChange: (id: ModelId) => void;
  onSetDefault: (id: ModelId) => void;
  close: () => void;
}) {
  const [css, theme] = useStyletron();
  const [hoveredId, setHoveredId] = useState<ModelId | null>(null);

  return (
    <div className={css({ minWidth: "200px", padding: "4px 0" })}>
      {MODEL_GROUPS.map((group) => (
        <div key={group.provider}>
          <div
            className={css({
              padding: "6px 12px",
              fontSize: "10px",
              fontWeight: 700,
              color: theme.colors.contentTertiary,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            })}
          >
            {group.provider}
          </div>
          {group.models.map((model) => {
            const isActive = model.id === value;
            const isDefault = model.id === defaultModel;
            const isHovered = model.id === hoveredId;
            const agent = providerAgent(group.provider);

            return (
              <div
                key={model.id}
                onMouseEnter={() => setHoveredId(model.id)}
                onMouseLeave={() => setHoveredId(null)}
                onClick={() => {
                  onChange(model.id);
                  close();
                }}
                className={css({
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "6px 12px",
                  cursor: "pointer",
                  fontSize: "12px",
                  fontWeight: isActive ? 600 : 400,
                  color: isActive ? theme.colors.contentPrimary : theme.colors.contentSecondary,
                  ":hover": { backgroundColor: "rgba(255, 255, 255, 0.06)" },
                })}
              >
                <AgentIcon agent={agent} size={12} />
                <span className={css({ flex: 1 })}>{model.label}</span>
                {isDefault ? <Star size={11} fill="#ff4f00" color="#ff4f00" /> : null}
                {!isDefault && isHovered ? (
                  <Star
                    size={11}
                    color={theme.colors.contentTertiary}
                    className={css({ cursor: "pointer", ":hover": { color: "#ff4f00" } })}
                    onClick={(event) => {
                      event.stopPropagation();
                      onSetDefault(model.id);
                    }}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
});

export const ModelPicker = memo(function ModelPicker({
  value,
  defaultModel,
  onChange,
  onSetDefault,
}: {
  value: ModelId;
  defaultModel: ModelId;
  onChange: (id: ModelId) => void;
  onSetDefault: (id: ModelId) => void;
}) {
  const [css, theme] = useStyletron();

  return (
    <StatefulPopover
      placement={PLACEMENT.topLeft}
      triggerType="click"
      autoFocus={false}
      overrides={{
        Body: {
          style: {
            backgroundColor: "#000000",
            borderTopLeftRadius: "8px",
            borderTopRightRadius: "8px",
            borderBottomLeftRadius: "8px",
            borderBottomRightRadius: "8px",
            border: `1px solid ${theme.colors.borderOpaque}`,
            boxShadow: "0 8px 24px rgba(0, 0, 0, 0.6)",
            zIndex: 100,
          },
        },
        Inner: {
          style: {
            backgroundColor: "transparent",
            padding: "0",
          },
        },
      }}
      content={({ close }) => <ModelPickerContent value={value} defaultModel={defaultModel} onChange={onChange} onSetDefault={onSetDefault} close={close} />}
    >
      <div className={css({ display: "inline-flex" })}>
        <button
          className={css({
            all: "unset",
            display: "flex",
            alignItems: "center",
            gap: "4px",
            cursor: "pointer",
            padding: "4px 8px",
            borderRadius: "6px",
            fontSize: "12px",
            fontWeight: 500,
            color: theme.colors.contentSecondary,
            backgroundColor: theme.colors.backgroundTertiary,
            border: `1px solid ${theme.colors.borderOpaque}`,
            ":hover": { color: theme.colors.contentPrimary },
          })}
        >
          {modelLabel(value)}
          <ChevronDown size={11} />
        </button>
      </div>
    </StatefulPopover>
  );
});
