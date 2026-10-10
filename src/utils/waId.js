'use strict';

/**
 * Turn a sheet "phone" value into a WhatsApp JID.
 *
 * Three shapes occur in practice:
 *   919876543210               a phone number        → @c.us
 *   120363341879375384         a modern group id     → @g.us
 *   919843556555-1402684704    a legacy group id     → @g.us, hyphen intact
 *
 * The legacy form is <creator number>-<creation timestamp>, and the hyphen is
 * part of the id. The old digits-only rule fused it into one 22-digit run and
 * produced a JID for a group that does not exist, so the send went nowhere —
 * silently, since WhatsApp does not complain about an unknown recipient id.
 * Of 151 groups on this account, 35 use that form.
 */
function toWAId(raw) {
  if (raw === null || raw === undefined) return null;

  const clean = String(raw).trim().replace(/\s/g, '');
  if (!clean) return null;

  // Already a JID — pass through.
  if (clean.endsWith('@g.us') || clean.endsWith('@c.us')) return clean;

  // Legacy group id: digits-digits.
  if (/^\d+-\d+$/.test(clean)) return `${clean}@g.us`;

  const digits = clean.replace(/\D/g, '');
  if (!digits) return null;

  // Modern group ids run 15+ digits; phone numbers are 10-14.
  return digits.length >= 15 ? `${digits}@g.us` : `${digits}@c.us`;
}

module.exports = { toWAId };
