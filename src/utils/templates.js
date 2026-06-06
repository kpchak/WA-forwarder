'use strict';

const DAYS   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];

/**
 * Replace template variables in text using the given date (defaults to now).
 *
 * Supported variables:
 *   <weekday>      → Monday, Tuesday, …
 *   <day>          → 1 – 31
 *   <day>+N        → day of month + N  (e.g. <day>+1 → tomorrow's day number)
 *   <day>-N        → day of month - N  (e.g. <day>-1 → yesterday's day number)
 *   <month>        → January, February, …
 *   <year>         → 2026
 */
function resolveTemplates(text, now = new Date()) {
  if (!text || !hasTemplates(text)) return text;

  return text
    // <day>+N  <day>-N  <day>
    .replace(/<day>([+-]\d+)?/g, (_, offset) => {
      const n = offset ? parseInt(offset, 10) : 0;
      return String(now.getDate() + n);
    })
    // <weekday>
    .replace(/<weekday>/g, DAYS[now.getDay()])
    // <month>
    .replace(/<month>/g, MONTHS[now.getMonth()])
    // <year>
    .replace(/<year>/g, String(now.getFullYear()));
}

function hasTemplates(text) {
  return /<(day|weekday|month|year)>/.test(text || '');
}

module.exports = { resolveTemplates, hasTemplates };
