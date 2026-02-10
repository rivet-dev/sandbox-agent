import type { UniversalItem } from "../../types/legacyApi";

export type TimelineEntry = {
  id: string;
  kind: "item" | "meta";
  time: string;
  item?: UniversalItem;
  deltaText?: string;
  meta?: {
    title: string;
    detail?: string;
    severity?: "info" | "error";
  };
};
