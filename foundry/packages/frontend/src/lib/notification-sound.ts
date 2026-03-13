import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

export type NotificationSoundId = "none" | "chime" | "ping";

const SOUNDS: Record<Exclude<NotificationSoundId, "none">, { label: string; src: string }> = {
  chime: { label: "Chime", src: "/sounds/notification-1.mp3" },
  ping: { label: "Ping", src: "/sounds/notification-2.mp3" },
};

const STORAGE_KEY = "foundry:notification-sound";

let currentValue: NotificationSoundId = (localStorage.getItem(STORAGE_KEY) as NotificationSoundId) || "none";
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) {
    listener();
  }
}

function getSnapshot(): NotificationSoundId {
  return currentValue;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setNotificationSound(id: NotificationSoundId) {
  currentValue = id;
  localStorage.setItem(STORAGE_KEY, id);
  notify();
}

export function useNotificationSound(): [NotificationSoundId, (id: NotificationSoundId) => void] {
  const value = useSyncExternalStore(subscribe, getSnapshot);
  return [value, setNotificationSound];
}

export function playNotificationSound() {
  const id = getSnapshot();
  if (id === "none") return;
  const sound = SOUNDS[id];
  if (!sound) return;
  const audio = new Audio(sound.src);
  audio.volume = 0.6;
  audio.play().catch(() => {});
}

export function previewNotificationSound(id: NotificationSoundId) {
  if (id === "none") return;
  const sound = SOUNDS[id];
  if (!sound) return;
  const audio = new Audio(sound.src);
  audio.volume = 0.6;
  audio.play().catch(() => {});
}

export function useAgentDoneNotification(status: "running" | "idle" | "error" | undefined) {
  const prevStatus = useRef(status);

  useEffect(() => {
    const prev = prevStatus.current;
    prevStatus.current = status;

    if (prev === "running" && status === "idle") {
      playNotificationSound();
    }
  }, [status]);
}

export const NOTIFICATION_SOUND_OPTIONS: { id: NotificationSoundId; label: string }[] = [
  { id: "none", label: "None" },
  { id: "chime", label: "Chime" },
  { id: "ping", label: "Ping" },
];
