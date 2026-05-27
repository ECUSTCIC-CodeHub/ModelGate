import { getGatewaySettings } from "@/lib/core/settings";
import { getOidcConfig } from "@/lib/auth/oidc";
import { modelGateFeatures } from "@/lib/core/features";

export type AuthStatus = {
  oidc_enabled: boolean;
  oidc_button_text: string;
  password_login_enabled: boolean;
  registration_enabled: boolean;
};

export function getAuthStatus(): AuthStatus {
  const config = getOidcConfig();
  const settings = getGatewaySettings();
  return {
    oidc_enabled: modelGateFeatures.oidc && config.enabled && !!config.issuerUrl && !!config.clientId,
    oidc_button_text: config.buttonText,
    password_login_enabled: modelGateFeatures.oidc ? settings.password_login_enabled === 1 : true,
    registration_enabled: settings.registration_enabled === 1,
  };
}
