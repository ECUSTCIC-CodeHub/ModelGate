import { getGatewaySettings } from "@/lib/settings";
import { getOidcConfig } from "@/lib/oidc";

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
    oidc_enabled: config.enabled && !!config.issuerUrl && !!config.clientId,
    oidc_button_text: config.buttonText,
    password_login_enabled: settings.password_login_enabled === 1,
    registration_enabled: settings.registration_enabled === 1,
  };
}
