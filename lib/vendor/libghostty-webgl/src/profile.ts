export interface ProfileHookEvent {
  name: string;
  ts?: number;
  dur?: number;
  data?: Record<string, string | number | boolean | null>;
}

interface ProfileHook {
  enabled: boolean;
  record: (event: ProfileHookEvent) => void;
  now?: () => number;
}

function getProfileHook(): ProfileHook | null {
  if (typeof window === "undefined") return null;
  const hook = (window as unknown as { __BOOTTY_PROFILE__?: ProfileHook }).__BOOTTY_PROFILE__;
  if (!hook || hook.enabled !== true || typeof hook.record !== "function") {
    return null;
  }
  return hook;
}

function getNow(hook?: ProfileHook | null): number {
  if (hook?.now) return hook.now();
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

export function profileEvent(
  name: string,
  data?: Record<string, string | number | boolean | null>,
): void {
  const hook = getProfileHook();
  if (!hook) return;
  hook.record({ name, ts: getNow(hook), data });
}

export function profileStart(): number | null {
  const hook = getProfileHook();
  if (!hook) return null;
  return getNow(hook);
}

export function profileDuration(
  name: string,
  start: number | null,
  data?: Record<string, string | number | boolean | null>,
): void {
  if (start === null) return;
  const hook = getProfileHook();
  if (!hook) return;
  const end = getNow(hook);
  hook.record({ name, ts: start, dur: end - start, data });
}
