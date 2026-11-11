export const MAX_SECONDS = 10_000_000;

const CLOCK = /^(?:(\d{1,7}):)?(\d{1,2}):(\d{1,2}(?:\.\d{1,6})?)$/;
const PLAIN = /^\d{1,8}(?:\.\d{1,6})?$/;

export function parseTime(input) {
  let seconds;
  if (typeof input === 'number') {
    seconds = input;
  } else if (typeof input === 'string') {
    const value = input.trim();
    if (PLAIN.test(value)) {
      seconds = Number(value);
    } else {
      const match = CLOCK.exec(value);
      if (!match) throw new RangeError(`Invalid time "${input}". Use seconds (e.g. 75.5) or [hh:]mm:ss[.fff] (e.g. 01:15.5).`);
      const hours = match[1] == null ? 0 : Number(match[1]);
      const minutes = Number(match[2]);
      const secs = Number(match[3]);
      if (minutes > 59 || secs >= 60) throw new RangeError(`Invalid time "${input}": minutes and seconds must be below 60.`);
      seconds = hours * 3600 + minutes * 60 + secs;
    }
  } else {
    throw new TypeError('Time must be a number of seconds or a timecode string.');
  }
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_SECONDS) {
    throw new RangeError(`Time must be between 0 and ${MAX_SECONDS} seconds.`);
  }
  return seconds;
}

export function formatTimecode(seconds) {
  const totalMs = Math.round(seconds * 1000);
  const ms = totalMs % 1000;
  const totalSeconds = (totalMs - ms) / 1000;
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

export function toTimecode(input) {
  return formatTimecode(parseTime(input));
}
