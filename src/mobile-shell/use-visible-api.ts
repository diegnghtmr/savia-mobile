import { useRef } from "react";

// A logical read retains its original scoped API even if it issues more HTTP requests after navigation.
export function useVisibleApi<T>(initial: T, next?: () => T) {
  const current = useRef<T | undefined>(undefined);
  return { api: () => current.current ?? initial, move: () => { current.current = next?.(); } };
}
