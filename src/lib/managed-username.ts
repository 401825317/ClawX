export const MANAGED_USERNAME_MAX_LENGTH = 20;

const MANAGED_USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,18}[a-z0-9])?$/;

export function isManagedUsernameValid(username: string): boolean {
  const value = username.trim();
  const normalized = value.toLowerCase();
  return value.length > 0
    && value.length <= MANAGED_USERNAME_MAX_LENGTH
    && MANAGED_USERNAME_PATTERN.test(normalized)
    && normalized.length === value.length;
}
