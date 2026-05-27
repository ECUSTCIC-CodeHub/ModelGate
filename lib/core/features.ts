export type ModelGateEdition = "full" | "lite";

function normalizeEdition(value: string | undefined): ModelGateEdition {
  return value === "lite" ? "lite" : "full";
}

export const modelGateEdition = normalizeEdition(
  process.env.NEXT_PUBLIC_MODELGATE_EDITION ?? process.env.MODELGATE_EDITION,
);

export const modelGateFeatures = {
  oidc: modelGateEdition === "full",
  periodQuota: modelGateEdition === "full",
  announcement: modelGateEdition === "full",
  webhook: modelGateEdition === "full",
} as const;

export function featureUnavailableMessage(featureName: string) {
  return `当前构建不包含${featureName}功能`;
}
