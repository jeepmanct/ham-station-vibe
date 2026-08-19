// International Morse code -- character to dit/dah pattern. Shared by
// reference.astro's send trainer and kiwisdr.astro's live CW decoder
// (which needs the reverse lookup, MORSE_DECODE below) so there's one
// source of truth for the alphabet instead of two independent copies.
export const MORSE: Record<string, string> = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---',
  K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-',
  U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
  '0': '-----', '1': '.----', '2': '..---', '3': '...--', '4': '....-', '5': '.....',
  '6': '-....', '7': '--...', '8': '---..', '9': '----.',
  '.': '.-.-.-', ',': '--..--', '?': '..--..', '/': '-..-.', '=': '-...-', '+': '.-.-.',
};

/** Pattern -> character, derived from MORSE above rather than hand-kept in sync. */
export const MORSE_DECODE: Record<string, string> = Object.fromEntries(
  Object.entries(MORSE).map(([ch, pattern]) => [pattern, ch]),
);
