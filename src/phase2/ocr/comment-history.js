const normalize = text => String(text || '').normalize('NFKC').replace(/\s/gu, '').toLowerCase();

function sameLine(a, b) {
  if (a === b) return true;
  // Only tolerate a single recognition substitution in a sufficiently long
  // line. Numbers and short comments retain exact identity.
  if (a.length < 6 || a.length !== b.length || a.match(/\d+/g)?.join() !== b.match(/\d+/g)?.join()) return false;
  let differences = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && ++differences > 1) return false;
  return true;
}

export class CommentHistory {
  constructor({ limit = 200, ttlMs = 120000, now = Date.now } = {}) {
    Object.assign(this, { limit, ttlMs, now });
    this.entries = [];
  }
  reset() { this.entries = []; }
  extract(lines) {
    const now = this.now();
    this.entries = this.entries.filter(entry => now - entry.at < this.ttlMs);
    const fresh = [];
    const anchored = lines.some(line => this.entries.some(entry => entry.key === normalize(line)));
    for (const value of lines.slice(0, 200)) {
      const text = String(value || '').trim().slice(0, 2000), key = normalize(text);
      if (!key) continue;
      const exact = this.entries.find(entry => entry.key === key);
      // Fuzzy correction requires another unchanged line in the same capture,
      // providing context that this is a scrolling/unchanged conversation.
      const match = exact || (anchored && this.entries.find(entry => sameLine(entry.key, key)));
      if (match) { match.at = now; continue; }
      fresh.push(text);
      this.entries.push({ key, at: now });
    }
    this.entries = this.entries.slice(-this.limit);
    return fresh.join('\n');
  }
}
