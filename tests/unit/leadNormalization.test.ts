import { describe, it, expect } from 'vitest';
import { normalizePhone, normalizeEmail } from '@/lib/utils/leadNormalization';

describe('normalizePhone', () => {
  it('strips formatting characters', () => {
    expect(normalizePhone('(555) 010-0100')).toBe('5550100100');
  });

  it('drops a leading US/Canada country code', () => {
    expect(normalizePhone('+1 555-010-0100')).toBe('5550100100');
    expect(normalizePhone('15550100100')).toBe('5550100100');
  });

  it('does not drop a leading 1 that is not a country code (10 digits)', () => {
    expect(normalizePhone('155-010-0100')).toBe('1550100100');
  });

  it('returns null for a value with no digits', () => {
    expect(normalizePhone('n/a')).toBeNull();
    expect(normalizePhone('')).toBeNull();
  });
});

describe('normalizeEmail', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmail('  Jane.Doe@Example.COM  ')).toBe('jane.doe@example.com');
  });

  it('returns null for an empty value', () => {
    expect(normalizeEmail('   ')).toBeNull();
  });
});
