import { describe, expect, it } from 'vitest';
import { isManagedUsernameValid } from '@/lib/managed-username';

describe('managed username validation', () => {
  it.each([
    'abc123',
    'abc_123',
    'abc-123',
    'ABC123',
    'a',
    'a1234567890123456789',
  ])('accepts %s', (username) => {
    expect(isManagedUsernameValid(username)).toBe(true);
  });

  it.each([
    '测试abc',
    '测试123',
    '_abc',
    'abc_',
    '-abc',
    'abc-',
    'abc.def',
    'a12345678901234567890',
  ])('rejects %s', (username) => {
    expect(isManagedUsernameValid(username)).toBe(false);
  });
});
