/** A display projection, never a dotenv evaluator or a replacement document. */
export interface EnvAssignment { name: string; value: string; line: number }
export interface EnvProjection {
  assignments: EnvAssignment[];
  /** Stop at the first uncertain statement; the rest remains available in Raw. */
  incompleteFromLine: number | null;
}

export function projectEnvDocument(raw: string): EnvProjection {
  const assignments: EnvAssignment[] = [];
  let offset = raw.startsWith('\uFEFF') ? 1 : 0;
  let line = 1;
  const newlineEnd = (index: number) => index + (raw[index] === '\r' && raw[index + 1] === '\n' ? 2 : 1);
  const isNewline = (char: string) => char === '\r' || char === '\n';
  while (offset < raw.length) {
    const startLine = line;
    let end = offset;
    while (end < raw.length && !isNewline(raw[end])) end++;
    const text = raw.slice(offset, end);
    if (!/^[\t ]*(?:#.*)?$/.test(text)) {
      const match = /^[\t ]*(?:export[\t ]+)?([A-Za-z_][A-Za-z0-9_]*)[\t ]*=/.exec(text);
      if (!match) return { assignments, incompleteFromLine: startLine };
      const valueStart = offset + match[0].length;
      let first = valueStart;
      while (raw[first] === ' ' || raw[first] === '\t') first++;
      const quote = raw[first];
      if (quote === '"' || quote === "'" || quote === '`') {
        let cursor = first + 1;
        let closed = false;
        while (cursor < raw.length) {
          const char = raw[cursor];
          if (char === quote) { cursor++; closed = true; break; }
          if (char === '\\' && cursor + 1 < raw.length && !isNewline(raw[cursor + 1])) {
            cursor += 2;
          } else if (isNewline(char)) {
            cursor = newlineEnd(cursor); line++;
          } else cursor++;
        }
        if (!closed) return { assignments, incompleteFromLine: startLine };
        end = cursor;
        while (end < raw.length && !isNewline(raw[end])) end++;
        if (!/^[\t ]*(?:#.*)?$/.test(raw.slice(cursor, end))) {
          return { assignments, incompleteFromLine: startLine };
        }
      } else {
        // Embedded quote spans and shell-style continuations are ambiguous.
        // Stop rather than exposing assignment-looking lines inside them as keys.
        const literal = raw.slice(valueStart, end).split('#', 1)[0];
        if (/["'`]/.test(literal) || /\\[\t ]*$/.test(literal)) {
          return { assignments, incompleteFromLine: startLine };
        }
      }
      assignments.push({ name: match[1], value: raw.slice(valueStart, end), line: startLine });
    }
    offset = end < raw.length ? newlineEnd(end) : end;
    line++;
  }
  return { assignments, incompleteFromLine: null };
}
