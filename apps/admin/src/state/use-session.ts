import { useStore } from "zustand";
import { sessionStore } from "../app";
import type { SessionState } from "./session";

export function useSession<T>(selector: (state: SessionState) => T): T {
  return useStore(sessionStore, selector);
}
