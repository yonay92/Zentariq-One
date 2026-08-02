// Normalizes phone/email for duplicate-detection matching only — the
// user-entered display value on lead_contact_info is never altered.

export function normalizePhone(phone: string): string | null {
  const digits = phone.replace(/\D/g, '');
  if (!digits) return null;
  // Drop a US/Canada country-code prefix so "+1 555-0100" and "555-0100"
  // normalize to the same value.
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
}

export function normalizeEmail(email: string): string | null {
  const trimmed = email.trim().toLowerCase();
  return trimmed || null;
}
