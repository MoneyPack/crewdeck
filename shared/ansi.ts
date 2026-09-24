/* eslint-disable no-control-regex */
// Strips terminal control sequences so captured output can be forwarded as plain text.

// OSC: ESC ] ... (BEL | ESC \)   — titles, hyperlinks, cwd reports.
const OSC = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
// DCS / SOS / PM / APC: ESC P|X|^|_ ... ESC \
const STRING_SEQ = /\x1b[PX^_][\s\S]*?\x1b\\/g;
// CSI: ESC [ params intermediates final  (also the 8-bit form 0x9b).
const CSI = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g;
// Two-byte / charset escapes: ESC ( B, ESC = , ESC 7, etc.
const ESC2 = /\x1b[ -/]*[0-~]/g;
// Remaining C0 controls except \t and \n (\r handled separately), plus DEL.
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;

/** Removes ANSI/VT escape sequences and stray control characters; normalises line endings to \n. */
export function stripAnsi(input: string): string {
  return input
    .replace(OSC, '')
    .replace(STRING_SEQ, '')
    .replace(CSI, '')
    .replace(ESC2, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(CONTROL, '');
}

/** Payloads larger than this (UTF-8 bytes) are written to a temp file and referenced by path. */
export const INLINE_FORWARD_LIMIT = 4096;

export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}
