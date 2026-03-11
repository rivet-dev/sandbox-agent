import { memo, useState } from "react";
import { useStyletron } from "baseui";
import { StatefulPopover, PLACEMENT } from "baseui/popover";
import { ChevronDown, ChevronUp, Star } from "lucide-react";

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
    <div className={css({ minWidth: "220px", padding: "6px 0" })}>
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
                  borderRadius: "6px",
                  marginLeft: "4px",
                  marginRight: "4px",
                  ":hover": { backgroundColor: "rgba(255, 255, 255, 0.08)" },
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
  const [isOpen, setIsOpen] = useState(false);

  return (
    <StatefulPopover
      placement={PLACEMENT.topLeft}
      triggerType="click"
      autoFocus={false}
      onOpen={() => setIsOpen(true)}
      onClose={() => setIsOpen(false)}
      overrides={{
        Body: {
          style: {
            backgroundColor: "rgba(32, 32, 32, 0.98)",
            backdropFilter: "blur(12px)",
            borderTopLeftRadius: "10px",
            borderTopRightRadius: "10px",
            borderBottomLeftRadius: "10px",
            borderBottomRightRadius: "10px",
            border: "1px solid rgba(255, 255, 255, 0.10)",
            boxShadow: "0 8px 32px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.04)",
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
            appearance: "none",
            WebkitAppearance: "none",
            background: "none",
            margin: "0",
            display: "flex",
            alignItems: "center",
            gap: "4px",
            cursor: "pointer",
            padding: "4px 8px",
            borderRadius: "6px",
            fontSize: "12px",
            fontWeight: 500,
            color: theme.colors.contentSecondary,
            backgroundColor: "rgba(255, 255, 255, 0.10)",
            border: "1px solid rgba(255, 255, 255, 0.14)",
            ":hover": { color: theme.colors.contentPrimary, backgroundColor: "rgba(255, 255, 255, 0.14)" },
          })}
        >
          {modelLabel(value)}
          {isOpen ? <ChevronDown size={11} /> : <ChevronUp size={11} />}
        </button>
      </div>
    </StatefulPopover>
  );
});
