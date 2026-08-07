export type AutoRotateIntent = {
  enabled: boolean;
  userControlled: boolean;
};

export const AUTO_ROTATE_SPEED = {
  standard: 0.32,
  reducedMotion: 0.12,
} as const;

export function initialAutoRotateIntent(prefersReducedMotion: boolean): AutoRotateIntent {
  return {
    enabled: !prefersReducedMotion,
    userControlled: false,
  };
}

export function toggleAutoRotateIntent(intent: AutoRotateIntent): AutoRotateIntent {
  return {
    enabled: !intent.enabled,
    userControlled: true,
  };
}

export function reconcileAutoRotateMotionPreference(
  intent: AutoRotateIntent,
  prefersReducedMotion: boolean,
): AutoRotateIntent {
  if (intent.userControlled) return intent;
  return initialAutoRotateIntent(prefersReducedMotion);
}

export function autoRotateSpeed(prefersReducedMotion: boolean) {
  return prefersReducedMotion
    ? AUTO_ROTATE_SPEED.reducedMotion
    : AUTO_ROTATE_SPEED.standard;
}

export function autoRotateStatusText(
  intent: AutoRotateIntent,
  prefersReducedMotion: boolean,
) {
  if (prefersReducedMotion) {
    return intent.enabled
      ? "감소 모션 · 저속 회전"
      : "감소 모션 · 자동 회전 정지";
  }
  return intent.enabled ? "자동 회전 켜짐" : "자동 회전 꺼짐";
}
