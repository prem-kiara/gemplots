// The DEV MODE ribbon (§4) shows once any response has carried a dev_otp this session.
'use client';
import { useSyncExternalStore } from 'react';

const KEY = 'gp.devmode';
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export function markDevMode() {
  if (typeof window === 'undefined') return;
  if (sessionStorage.getItem(KEY) === '1') return;
  sessionStorage.setItem(KEY, '1');
  emit();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot() {
  return typeof window !== 'undefined' && sessionStorage.getItem(KEY) === '1';
}

export function useDevMode(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
