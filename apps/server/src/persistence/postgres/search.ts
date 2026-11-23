const forms: Array<string> = [];
const folded: Array<string> = [];
// Match paletteSearch's one-code-unit folding, including kana, Greek and Cyrillic, independent of database locale.
for (let point = 0x80; point < 0x10000; point++) {
  const char = String.fromCodePoint(point);
  const normalized = char
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace("ς", "σ")
    .replace(/[‘’]/, "'");
  if (normalized.length === 1 && normalized !== char) {
    forms.push(char);
    folded.push(normalized);
  }
}

export const POSTGRES_SEARCH_STATEMENTS: readonly string[] = [
  `CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public`,
  `CREATE FUNCTION stardust_search_fold(value text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $stardust_fold$
      SELECT lower(translate(value, '${forms.join("").replaceAll("'", "''")}', '${folded.join("").replaceAll("'", "''")}'))
    $stardust_fold$`,
  `CREATE INDEX orchestration_v2_messages_text_trgm_idx
    ON orchestration_v2_projection_messages USING gin
      (stardust_search_fold(COALESCE(search_text, json_extract(payload_json, '$.text'))) public.gin_trgm_ops)
    WHERE streaming = 0`,
];
