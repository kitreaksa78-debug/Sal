// The "Contact with Google" action on the welcome screen. It opens a Gmail
// draft; when the visitor has signed in with Google their account details are
// already written into the message.

/** Support inbox. Change this one constant to point the button elsewhere. */
export const CONTACT_EMAIL = 'kitreaksa78@gmail.com';

const CONTACT_SUBJECT = 'KhmerDub AI — សំណួរ / ជំនួយ';

export interface ContactIdentity {
  name?: string;
  email?: string;
}

function buildBody(identity?: ContactIdentity | null): string {
  const lines = ['សួស្តីក្រុមការងារ KhmerDub AI,', '', 'ខ្ញុំចង់សួរអំពី៖ ', '', '—'];

  if (identity?.name) lines.push(`ឈ្មោះ: ${identity.name}`);
  if (identity?.email) lines.push(`អ៊ីមែល: ${identity.email}`);
  if (!identity?.name && !identity?.email) lines.push('ឈ្មោះ:', 'អ៊ីមែល:');

  return lines.join('\n');
}

/** Gmail compose in a new tab — the "contact with Google" action. */
export function gmailComposeUrl(identity?: ContactIdentity | null): string {
  const params = new URLSearchParams({
    view: 'cm',
    fs: '1',
    to: CONTACT_EMAIL,
    su: CONTACT_SUBJECT,
    body: buildBody(identity),
  });

  return `https://mail.google.com/mail/?${params.toString()}`;
}

/** Fallback for visitors who do not use Gmail. */
export function mailtoUrl(identity?: ContactIdentity | null): string {
  const params = new URLSearchParams({
    subject: CONTACT_SUBJECT,
    body: buildBody(identity),
  });
  return `mailto:${CONTACT_EMAIL}?${params.toString()}`;
}
