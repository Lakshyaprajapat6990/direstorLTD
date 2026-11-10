"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

// Undo and redo for everything the editor changes (text, formatting, appearance, order, added and removed sections). Snapshots of the
// whole content object: it is small (under 96 KiB) and immutable, so a snapshot is just a reference. Edits made within a short time
// of each other (typing, dragging a colour) are one step; structural actions call boundary() first so they are always their own step.

export interface HistoryApi {
  undo(): void;
  redo(): void;
  canUndo: boolean;
  canRedo: boolean;
}

const Ctx = createContext<HistoryApi>({ undo: () => {}, redo: () => {}, canUndo: false, canRedo: false });
export const HistoryProvider = Ctx.Provider;
export const useHistory = () => useContext(Ctx);

const COALESCE_MS = 700;
const MAX_STEPS = 100;

export function useUndoStack<T>(value: T, set: (v: T) => void) {
  const past = useRef<T[]>([]);
  const future = useRef<T[]>([]);
  const last = useRef<T>(value);
  const lastAt = useRef(0);
  const skip = useRef(false);
  const [, bump] = useState(0);

  useEffect(() => {
    if (skip.current) {
      skip.current = false;
      last.current = value;
      return;
    }
    if (value === last.current) return;
    const now = Date.now();
    if (now - lastAt.current > COALESCE_MS || past.current.length === 0) {
      past.current.push(last.current);
      if (past.current.length > MAX_STEPS) past.current.shift();
    }
    lastAt.current = now;
    future.current = [];
    last.current = value;
    bump((n) => n + 1);
  }, [value]);

  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (prev === undefined) return;
    future.current.push(last.current);
    skip.current = true;
    lastAt.current = 0;
    set(prev);
    bump((n) => n + 1);
  }, [set]);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (next === undefined) return;
    past.current.push(last.current);
    skip.current = true;
    lastAt.current = 0;
    set(next);
    bump((n) => n + 1);
  }, [set]);

  // The next change starts a new step (call before a structural change).
  const boundary = useCallback(() => {
    lastAt.current = 0;
  }, []);

  // Forget all steps (after content is replaced by the server's copy).
  const clear = useCallback((v: T) => {
    past.current = [];
    future.current = [];
    last.current = v;
    lastAt.current = 0;
    skip.current = false;
    bump((n) => n + 1);
  }, []);

  const api: HistoryApi = { undo, redo, canUndo: past.current.length > 0, canRedo: future.current.length > 0 };
  return { api, boundary, clear };
}
