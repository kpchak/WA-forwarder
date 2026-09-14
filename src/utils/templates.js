'use strict';

const DAYS   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];

const DEFAULT_TIMEZONE = process.env.SCHEDULE_TIMEZONE || 'Asia/Kolkata';

/**
 * Read the wall-clock date/weekday for `date` in `timeZone`, regardless of
 * the server process's own timezone (this server runs in UTC, so a schedule
 * firing at e.g. 00:30 IST is still the previous UTC day — using the raw
 * Date getters here previously caused <day> to resolve to the wrong date
 * for early-morning IST schedules).
 */
function _localParts(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'long',
  });
  const parts = {};
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
  return {
    day:     parseInt(parts.day, 10),
    month:   parseInt(parts.month, 10) - 1, // 0-indexed to match MONTHS
    year:    parseInt(parts.year, 10),
    weekday: parts.weekday,
  };
}

/**
 * Replace template variables in text using the given date (defaults to now).
 * Date components are resolved in `timeZone` (defaults to the schedule
 * timezone), not the server's local/process timezone.
 *
 * Supported variables:
 *   <weekday>      → Monday, Tuesday, …
 *   <day>          → 1 – 31
 *   <day>+N        → day of month + N  (e.g. <day>+1 → tomorrow's day number)
 *   <day>-N        → day of month - N  (e.g. <day>-1 → yesterday's day number)
 *   <month>        → January, February, …
 *   <year>         → 2026
 */
function resolveTemplates(text, now = new Date(), name = '', timeZone = DEFAULT_TIMEZONE) {
  if (!text) return text;

  const { day, month, year, weekday } = _localParts(now, timeZone);

  return text
    .replace(/<day>([+-]\d+)?/g, (_, offset) => {
      const n = offset ? parseInt(offset, 10) : 0;
      return String(day + n);
    })
    .replace(/<weekday>/g, weekday)
    .replace(/<month>/g, MONTHS[month])
    .replace(/<year>/g, String(year))
    .replace(/<name>/g, name || '');
}

function hasTemplates(text) {
  return /<(day|weekday|month|year|name)>/.test(text || '');
}

module.exports = { resolveTemplates, hasTemplates };
