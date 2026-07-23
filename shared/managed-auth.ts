/**
 * Shared managed-auth contract.
 *
 * The renderer-facing types in this file deliberately do not contain any
 * credential-bearing fields. Main-process code may keep tokens internally,
 * but it must strip them before returning a managed-auth result to the UI.
 */

export type ManagedAuthSource = 'auth-token' | 'login' | 'register';

export type ManagedAuthUser = {
  id?: string;
  username?: string;
  email?: string;
  displayName?: string;
};

export type ManagedAuthDeviceStatus =
  | 'active'
  | 'activated'
  | 'enabled'
  | 'pending'
  | 'disabled';

export type ManagedAuthDevice = {
  id: string;
  status?: ManagedAuthDeviceStatus;
  activated?: boolean;
};

export type ManagedAuthBootstrap = {
  service?: {
    name?: string;
    displayName?: string;
    apiOrigin?: string;
  };
  auth?: {
    registrationEnabled?: boolean;
    emailVerifyEnabled?: boolean;
    loginEnabled?: boolean;
    activationRequired?: boolean;
  };
  runtime?: {
    providerId?: string;
    accountId?: string;
    baseUrl?: string;
    apiProtocol?: string;
    defaultModel?: string;
  };
  offline?: {
    graceSeconds?: number;
    verifyMemoryCacheSeconds?: number;
  };
};

export type ManagedAuthStatus = {
  managed: boolean;
  localOnly?: boolean;
  hasAuthToken: boolean;
  hasRefreshToken: boolean;
  hasRelayToken: boolean;
  authValid: boolean;
  authRejected?: boolean;
  authErrorCode?: string;
  authError?: string;
  deviceActivated: boolean;
  activationRequired: boolean;
  user?: ManagedAuthUser;
  auth?: { user?: ManagedAuthUser };
  device?: ManagedAuthDevice;
  bootstrap: ManagedAuthBootstrap;
  lastVerifiedAt?: number;
  offlineGraceExpiresAt?: number;
  gatewayReloaded?: boolean;
  gatewayReloadError?: string;
};

export type ManagedAuthResult = {
  success: boolean;
  status?: ManagedAuthStatus;
  user?: ManagedAuthUser;
  errorCode?: string;
  message?: string;
};

export type ManagedAuthLoginPayload = {
  account: string;
  password: string;
  activationCode?: string;
  verifyCode?: string;
  turnstileToken?: string;
};

export type ManagedAuthRegisterPayload = {
  account: string;
  username?: string;
  password: string;
  activationCode?: string;
  verifyCode?: string;
  turnstileToken?: string;
};

export type ManagedAuthActivationCheckPayload = {
  code: string;
};

export type ManagedAuthVerificationCodePayload = {
  account: string;
  turnstileToken?: string;
};

export type ManagedAuthVerifyPayload = {
  force?: boolean;
};

export type ManagedAuthRefreshPayload = {
  force?: boolean;
};

export type ManagedAuthStatusResult = ManagedAuthStatus;
export type ManagedAuthActivationCheckResult = {
  valid: boolean;
  errorCode?: string;
};
export type ManagedAuthVerificationCodeResult = {
  success: boolean;
  errorCode?: string;
  message?: string;
  countdown?: number;
};
export type ManagedAuthVerifyResult = ManagedAuthStatus;
export type ManagedAuthBootstrapResult = ManagedAuthBootstrap;
export type ManagedAuthLogoutResult = {
  success: boolean;
};
