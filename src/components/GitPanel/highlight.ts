/**
 * Lightweight, dependency-free syntax tokenizer for diff lines (CD-19).
 *
 * Works line-by-line (diff lines are not contiguous source), so multi-line
 * constructs such as block comments are only recognised heuristically.
 * Output is a flat token list; unknown languages yield a single plain token.
 */

export type TokKind = 'kw' | 'str' | 'com' | 'num' | 'fn' | 'type' | 'punc' | 'plain';

export interface Token {
  kind: TokKind;
  text: string;
}

interface LangDef {
  keywords: Set<string>;
  lineComments: string[];
  block?: [string, string];
  quotes: string;
  /** Treat Capitalized identifiers as types. */
  capTypes: boolean;
  caseInsensitive?: boolean;
}

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

const C_LIKE_BASE =
  'if else for while do switch case default break continue return goto sizeof typedef struct union enum static const volatile extern inline void char short int long float double signed unsigned bool true false null nullptr';

const LANGS: Record<string, LangDef> = {
  js: {
    keywords: words(
      'abstract as async await break case catch class const continue debugger declare default delete do else enum export extends false finally for from function get if implements import in infer instanceof interface is keyof let namespace new null of override private protected public readonly return satisfies set static super switch this throw true try type typeof undefined unique var void while with yield any boolean never number object string symbol unknown bigint',
    ),
    lineComments: ['//'],
    block: ['/*', '*/'],
    quotes: `'"\``,
    capTypes: true,
  },
  py: {
    keywords: words(
      'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return self True try while with yield match case',
    ),
    lineComments: ['#'],
    quotes: `'"`,
    capTypes: true,
  },
  rs: {
    keywords: words(
      'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str',
    ),
    lineComments: ['//'],
    block: ['/*', '*/'],
    quotes: `"`,
    capTypes: true,
  },
  go: {
    keywords: words(
      'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false string int int64 int32 uint byte rune error bool float64 any',
    ),
    lineComments: ['//'],
    block: ['/*', '*/'],
    quotes: `'"\``,
    capTypes: true,
  },
  c: {
    keywords: words(
      `${C_LIKE_BASE} class public private protected virtual override template typename namespace using new delete this throw try catch final abstract interface package import extends implements var let fun val when is in out ref readonly async await string object`,
    ),
    lineComments: ['//'],
    block: ['/*', '*/'],
    quotes: `'"`,
    capTypes: true,
  },
  css: {
    keywords: words('important media supports import keyframes from to and not only screen root hover focus active'),
    lineComments: [],
    block: ['/*', '*/'],
    quotes: `'"`,
    capTypes: false,
  },
  json: { keywords: words('true false null'), lineComments: [], quotes: `"`, capTypes: false },
  sh: {
    keywords: words(
      'if then else elif fi for while do done case esac function return in export local echo exit set unset source param foreach begin process end try catch finally throw',
    ),
    lineComments: ['#'],
    quotes: `'"`,
    capTypes: false,
    caseInsensitive: true,
  },
  sql: {
    keywords: words(
      'select from where insert into values update set delete create table index view drop alter add column primary key foreign references not null unique default and or on join left right inner outer group by order having limit offset as integer text real blob if exists begin commit rollback trigger',
    ),
    lineComments: ['--'],
    block: ['/*', '*/'],
    quotes: `'"`,
    capTypes: false,
    caseInsensitive: true,
  },
  yaml: { keywords: words('true false null yes no on off'), lineComments: ['#'], quotes: `'"`, capTypes: false },
  toml: { keywords: words('true false'), lineComments: ['#'], quotes: `'"`, capTypes: false },
};

const EXT_MAP: Record<string, string> = {
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'js', tsx: 'js', mts: 'js', cts: 'js',
  py: 'py', pyw: 'py',
  rs: 'rs',
  go: 'go',
  c: 'c', h: 'c', cc: 'c', cpp: 'c', cxx: 'c', hpp: 'c', hh: 'c', java: 'c', cs: 'c', kt: 'c', kts: 'c', swift: 'c', scala: 'c', dart: 'c',
  css: 'css', scss: 'css', less: 'css',
  json: 'json', jsonc: 'js',
  sh: 'sh', bash: 'sh', zsh: 'sh', ps1: 'sh', psm1: 'sh',
  sql: 'sql',
  yml: 'yaml', yaml: 'yaml',
  toml: 'toml', ini: 'toml',
};

/** Returns the language id for a path, or null if unsupported. */
export function langForPath(path: string): string | null {
  const base = path.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot < 0) return base === 'Dockerfile' || base === 'Makefile' ? 'sh' : null;
  return EXT_MAP[base.slice(dot + 1).toLowerCase()] ?? null;
}

/** Lines longer than this are not tokenized (minified bundles etc.). */
export const MAX_TOKENIZE_LEN = 2000;

const IDENT_START = /[A-Za-z_$@]/;
const IDENT_PART = /[A-Za-z0-9_$-]/;
const NUM_RE = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)[a-zA-Z]*/;
const PUNC = '{}[]();,.:<>=+-*/%&|^!~?';

/** Tokenizes a single source line. Adjacent tokens of the same kind are merged. */
export function tokenizeLine(text: string, lang: string | null): Token[] {
  const def = lang ? LANGS[lang] : undefined;
  if (!def || !text || text.length > MAX_TOKENIZE_LEN) return [{ kind: 'plain', text }];

  const out: Token[] = [];
  const push = (kind: TokKind, t: string) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += t;
    else out.push({ kind, text: t });
  };

  // Heuristic: continuation lines of a block comment ("* foo", "*/").
  if (def.block) {
    const trimmed = text.trimStart();
    if (trimmed.startsWith('*') && !trimmed.startsWith('*=') && def.block[0] === '/*') {
      const end = text.indexOf(def.block[1]);
      if (end < 0) return [{ kind: 'com', text }];
      push('com', text.slice(0, end + def.block[1].length));
      text = text.slice(end + def.block[1].length);
      if (!text) return out;
    }
  }

  const n = text.length;
  let i = 0;
  // Identifier chars: '-' is only an ident char in css/sh.
  const dashIdent = lang === 'css' || lang === 'sh';
  while (i < n) {
    const ch = text[i];

    // Line comment
    const lc = def.lineComments.find((p) => text.startsWith(p, i));
    if (lc) {
      push('com', text.slice(i));
      break;
    }
    // Block comment (may be unterminated on this line)
    if (def.block && text.startsWith(def.block[0], i)) {
      const end = text.indexOf(def.block[1], i + def.block[0].length);
      const stop = end < 0 ? n : end + def.block[1].length;
      push('com', text.slice(i, stop));
      i = stop;
      continue;
    }
    // String
    if (def.quotes.includes(ch)) {
      let j = i + 1;
      while (j < n && text[j] !== ch) j += text[j] === '\\' ? 2 : 1;
      const stop = Math.min(n, j + 1);
      push('str', text.slice(i, stop));
      i = stop;
      continue;
    }
    // Number (not part of an identifier)
    if (/\d/.test(ch)) {
      const m = NUM_RE.exec(text.slice(i));
      if (m) {
        push('num', m[0]);
        i += m[0].length;
        continue;
      }
    }
    // Identifier / keyword
    if (IDENT_START.test(ch)) {
      let j = i + 1;
      while (j < n && IDENT_PART.test(text[j]) && (text[j] !== '-' || dashIdent)) j++;
      const word = text.slice(i, j);
      const key = def.caseInsensitive ? word.toLowerCase() : word;
      let k = j;
      while (k < n && text[k] === ' ') k++;
      let kind: TokKind = 'plain';
      if (def.keywords.has(key)) kind = 'kw';
      else if (text[k] === '(') kind = 'fn';
      else if (def.capTypes && /^[A-Z][A-Za-z0-9_]*[a-z][A-Za-z0-9_]*$/.test(word)) kind = 'type';
      push(kind, word);
      i = j;
      continue;
    }
    if (PUNC.includes(ch)) {
      push('punc', ch);
      i++;
      continue;
    }
    push('plain', ch);
    i++;
  }
  return out;
}
