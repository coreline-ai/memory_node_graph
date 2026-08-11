export type LuminosityPreset = "normal" | "bright" | "supernova";
export type FocusContrast = "low" | "medium" | "high";

export type LuminosityControls = {
  overall: number;
  edges: number;
  bloom: number;
  particles: number;
  focusContrast: FocusContrast;
};

export type FocusContrastSettings = {
  focusedNodeBoost: number;
  dimmedNodeBoost: number;
  dimmedEdgeBrightness: number;
};

export type LuminositySettings = {
  light: number;
  bloom: number;
  dust: number;
  photon: number;
  edgeIntensity: number;
  particleIntensity: number;
  ambientNodeBoost: number;
  ambientEdgeBrightness: number;
  outputCeiling: number;
};

type ResolveLuminosityOptions = {
  compact: boolean;
  previewV2: boolean;
};

const LIMITS: Record<keyof LuminositySettings, readonly [number, number]> = {
  light: [0.5, 1.75],
  bloom: [0, 1.45],
  dust: [0, 0.38],
  photon: [0, 1],
  edgeIntensity: [0, 1],
  particleIntensity: [0, 1],
  ambientNodeBoost: [1, 1.32],
  ambientEdgeBrightness: [0, 0.7],
  outputCeiling: [1, 2.5],
};

const clampFinite = (value: number, min: number, max: number) =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;

const interpolateStops = (
  value: number,
  stops: ReadonlyArray<readonly [number, number]>,
) => {
  const clampedValue = clampFinite(value, stops[0][0], stops.at(-1)![0]);
  for (let index = 1; index < stops.length; index += 1) {
    const [rightInput, rightOutput] = stops[index];
    const [leftInput, leftOutput] = stops[index - 1];
    if (clampedValue <= rightInput) {
      const progress = (clampedValue - leftInput) / (rightInput - leftInput);
      return leftOutput + (rightOutput - leftOutput) * progress;
    }
  }
  return stops.at(-1)![1];
};

export function normalizeLuminositySettings(
  settings: LuminositySettings,
): LuminositySettings {
  return Object.fromEntries(
    Object.entries(settings).map(([key, value]) => {
      const [min, max] = LIMITS[key as keyof LuminositySettings];
      return [key, clampFinite(value, min, max)];
    }),
  ) as LuminositySettings;
}

export const luminosityPresetControls: Record<
  LuminosityPreset,
  LuminosityControls
> = {
  normal: {
    overall: 55,
    edges: 20,
    bloom: 12,
    particles: 15,
    focusContrast: "medium",
  },
  bright: {
    overall: 70,
    edges: 32,
    bloom: 28,
    particles: 30,
    focusContrast: "medium",
  },
  supernova: {
    overall: 90,
    edges: 50,
    bloom: 45,
    particles: 50,
    focusContrast: "medium",
  },
};

export const defaultCustomLuminosityControls: LuminosityControls = {
  overall: 150,
  edges: 50,
  bloom: 20,
  particles: 100,
  focusContrast: "medium",
};

export function normalizeLuminosityControls(
  controls: LuminosityControls,
): LuminosityControls {
  return {
    overall: clampFinite(controls.overall, 50, 150),
    edges: clampFinite(controls.edges, 0, 100),
    bloom: clampFinite(controls.bloom, 0, 100),
    particles: clampFinite(controls.particles, 0, 100),
    focusContrast:
      controls.focusContrast === "low" || controls.focusContrast === "high"
        ? controls.focusContrast
        : "medium",
  };
}

export function resolveLuminosityControls(
  input: LuminosityControls,
): LuminositySettings {
  const controls = normalizeLuminosityControls(input);
  return normalizeLuminositySettings({
    light: interpolateStops(controls.overall, [
      [50, 0.82],
      [75, 1.04],
      [100, 1.32],
      [150, 1.68],
    ]),
    bloom: interpolateStops(controls.bloom, [
      [0, 0],
      [45, 0.96],
      [70, 1.14],
      [100, 1.38],
    ]),
    dust: interpolateStops(controls.particles, [
      [0, 0],
      [35, 0.2],
      [65, 0.26],
      [100, 0.34],
    ]),
    photon: interpolateStops(controls.particles, [
      [0, 0],
      [35, 0.66],
      [65, 0.88],
      [100, 1],
    ]),
    edgeIntensity: interpolateStops(controls.edges, [
      [0, 0],
      [20, 0.32],
      [35, 0.5],
      [55, 0.72],
      [100, 1],
    ]),
    particleIntensity: controls.particles / 100,
    ambientNodeBoost: interpolateStops(controls.overall, [
      [50, 1],
      [75, 1.06],
      [100, 1.14],
      [150, 1.26],
    ]),
    ambientEdgeBrightness: interpolateStops(controls.edges, [
      [0, 0],
      [20, 0.3],
      [35, 0.4],
      [55, 0.49],
      [100, 0.66],
    ]),
    outputCeiling: interpolateStops(controls.overall, [
      [50, 1.7],
      [75, 1.9],
      [100, 2.15],
      [150, 2.35],
    ]),
  });
}

export function resolveFocusContrast(
  contrast: FocusContrast,
): FocusContrastSettings {
  return {
    low: {
      focusedNodeBoost: 1.46,
      dimmedNodeBoost: 0.365,
      dimmedEdgeBrightness: 0.25,
    },
    medium: {
      focusedNodeBoost: 1.72,
      dimmedNodeBoost: 0.344,
      dimmedEdgeBrightness: 0.2,
    },
    high: {
      focusedNodeBoost: 1.94,
      dimmedNodeBoost: 0.291,
      dimmedEdgeBrightness: 0.15,
    },
  }[contrast] ?? {
    focusedNodeBoost: 1.72,
    dimmedNodeBoost: 0.344,
    dimmedEdgeBrightness: 0.2,
  };
}

const classicPresets: Record<LuminosityPreset, LuminositySettings> = {
  normal: {
    light: 1,
    bloom: 0.92,
    dust: 0.18,
    photon: 0.62,
    edgeIntensity: 1,
    particleIntensity: 1,
    ambientNodeBoost: 1,
    ambientEdgeBrightness: 0.33,
    outputCeiling: 2.5,
  },
  bright: {
    light: 1.28,
    bloom: 1.08,
    dust: 0.24,
    photon: 0.84,
    edgeIntensity: 1,
    particleIntensity: 1,
    ambientNodeBoost: 1,
    ambientEdgeBrightness: 0.33,
    outputCeiling: 2.5,
  },
  supernova: {
    light: 1.56,
    bloom: 1.24,
    dust: 0.3,
    photon: 1,
    edgeIntensity: 1,
    particleIntensity: 1,
    ambientNodeBoost: 1,
    ambientEdgeBrightness: 0.33,
    outputCeiling: 2.5,
  },
};

export const luminosityV2Presets: Record<LuminosityPreset, LuminositySettings> = {
  normal: resolveLuminosityControls(luminosityPresetControls.normal),
  bright: resolveLuminosityControls(luminosityPresetControls.bright),
  supernova: resolveLuminosityControls(luminosityPresetControls.supernova),
};

export function resolveLuminositySettings(
  preset: LuminosityPreset,
  options: ResolveLuminosityOptions,
): LuminositySettings {
  const effectivePreset =
    !options.previewV2 && options.compact && preset === "supernova"
      ? "bright"
      : preset;
  const source = options.previewV2
    ? luminosityV2Presets[effectivePreset]
    : classicPresets[effectivePreset];
  return normalizeLuminositySettings(source);
}
