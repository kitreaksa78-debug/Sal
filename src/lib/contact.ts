// Helpers behind the welcome screen's "Contact with Google" button: the inbox
// address, the visitor profile remembered on this device, and the Gmail compose
// link. The profile is stored locally so a returning visitor does not have to
// retype their details.

import type { Plan } from './api';

/** Support inbox. Change this one constant to point the button elsewhere. */
export const CONTACT_EMAIL = 'kitreaksa78@gmail.com';

const PROFILE_KEY = 'khmerdub_contact_profile';
const DEVICE_KEY = 'khmerdub_device_id';

export interface ContactProfile {
  name: string;
  email: string;
  message: string;
}

export const EMPTY_PROFILE: ContactProfile = { name: '', email: '', message: '' };

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private browsing / storage disabled */
  }
}

/** Stable per-browser id, so repeat contacts from one device can be grouped. */
export function getDeviceId(): string {
  const stored = readLocal(DEVICE_KEY);
  if (stored) return stored;

  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const id = `dev_${random}`;
  writeLocal(DEVICE_KEY, id);
  return id;
}

export function getContactProfile(): ContactProfile {
  const stored = readLocal(PROFILE_KEY);
  if (!stored) return { ...EMPTY_PROFILE };

  try {
    const parsed = JSON.parse(stored) as Partial<ContactProfile>;
    return {
      name: parsed.name || '',
      email: parsed.email || '',
      message: parsed.message || '',
    };
  } catch {
    return { ...EMPTY_PROFILE };
  }
}

export function saveContactProfile(profile: ContactProfile): void {
  writeLocal(
    PROFILE_KEY,
    JSON.stringify({
      name: profile.name.trim(),
      email: profile.email.trim().toLowerCase(),
      message: profile.message.trim(),
    })
  );
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
}

/**
 * Gmail compose in a new tab, with the visitor's own details already written
 * into the draft so all they have to do is press send.
 */
export function gmailComposeUrl(profile: ContactProfile, plan: Plan): string {
  const body = [
    'សួស្តីក្រុមការងារ KhmerDub AI,',
    '',
    profile.message.trim() || 'ខ្ញុំចង់សួរអំពី៖ ',
    '',
    '—',
    `ឈ្មោះ: ${profile.name.trim()}`,
    `អ៊ីមែល: ${profile.email.trim()}`,
    `ប្រភេទគណនី: ${plan === 'pro' ? 'Pro' : 'Free'}`,
  ].join('\n');

  const params = new URLSearchParams({
    view: 'cm',
    fs: '1',
    to: CONTACT_EMAIL,
    su: 'KhmerDub AI — សំណួរ / ជំនួយ',
    body,
  });

  return `https://mail.google.com/mail/?${params.toString()}`;
}

/** Fallback for visitors who do not use Gmail. */
export function mailtoUrl(profile: ContactProfile): string {
  const params = new URLSearchParams({
    subject: 'KhmerDub AI — សំណួរ / ជំនួយ',
    body: profile.message.trim(),
  });
  return `mailto:${CONTACT_EMAIL}?${params.toString()}`;
}
