// JSON stays text at the persistence boundary; typed JSON values are used only inside updates.
export const POSTGRES_FUNCTION_STATEMENTS: readonly string[] = [
  `CREATE FUNCTION json_valid(document text) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$ BEGIN
      IF document IS NULL THEN RETURN false; END IF;
      PERFORM document::jsonb; RETURN true;
    EXCEPTION WHEN invalid_text_representation THEN RETURN false; END $$`,
  `CREATE FUNCTION json_extract(document text, path text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
      SELECT CASE jsonb_typeof(value)
        WHEN 'null' THEN NULL WHEN 'boolean' THEN CASE WHEN value = 'true'::jsonb THEN '1' ELSE '0' END
        WHEN 'string' THEN value #>> '{}' ELSE value::text END
      FROM (SELECT jsonb_path_query_first(document::jsonb, path::jsonpath) AS value) AS extracted
    $$`,
  `CREATE FUNCTION json_type(document text, path text DEFAULT '$') RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
      SELECT CASE jsonb_typeof(value)
        WHEN 'string' THEN 'text'
        WHEN 'boolean' THEN value::text
        WHEN 'number' THEN CASE WHEN value::text ~ '^-?[0-9]+$' THEN 'integer' ELSE 'real' END
        ELSE jsonb_typeof(value) END
      FROM (SELECT jsonb_path_query_first(document::jsonb, path::jsonpath) AS value) AS extracted
    $$`,
  `CREATE FUNCTION json_array_length(document text, path text DEFAULT '$') RETURNS integer
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
      SELECT CASE WHEN jsonb_typeof(value) = 'array' THEN jsonb_array_length(value)
        WHEN value IS NULL THEN NULL ELSE 0 END
      FROM (SELECT jsonb_path_query_first(document::jsonb, path::jsonpath) AS value) AS extracted
    $$`,
  `CREATE FUNCTION "json"(document text) RETURNS jsonb
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$ SELECT document::jsonb $$`,
  `CREATE FUNCTION json_key_path(path text) RETURNS text[]
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
      SELECT regexp_split_to_array(regexp_replace(regexp_replace(path, '^\\$\\.?', ''), '\\[([0-9]+)\\]', '.\\1', 'g'), '\\.')
    $$`,
  `CREATE FUNCTION json_set(document text, path text, value jsonb) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
      SELECT jsonb_set(document::jsonb, json_key_path(path), COALESCE(value, 'null'::jsonb), true)::text
    $$`,
  `CREATE FUNCTION json_set(document text, path text, value json) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT json_set(document, path, value::jsonb) $$`,
  ...["text", "bigint", "integer", "numeric"].map(
    (type) => `CREATE FUNCTION json_set(document text, path text, value ${type}) RETURNS text
      LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT json_set(document, path, to_jsonb(value)) $$`,
  ),
  `CREATE FUNCTION json_set(document text, path text, value text, second_path text, second_value bigint) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
      SELECT json_set(json_set(document, path, value), second_path, second_value)
    $$`,
  `CREATE FUNCTION json_remove(document text, path text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$ SELECT (document::jsonb #- json_key_path(path))::text $$`,
  `CREATE FUNCTION json_remove(document text, first_path text, second_path text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$ SELECT json_remove(json_remove(document, first_path), second_path) $$`,
  `CREATE FUNCTION json_tree(document text, path text) RETURNS TABLE(value text, type text)
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
      SELECT CASE jsonb_typeof(node)
        WHEN 'string' THEN node #>> '{}' WHEN 'null' THEN NULL ELSE node::text END,
        CASE jsonb_typeof(node) WHEN 'string' THEN 'text' ELSE jsonb_typeof(node) END
      FROM jsonb_path_query(jsonb_path_query_first(document::jsonb, path::jsonpath), 'strict $.**') AS nodes(node)
    $$`,
  `CREATE FUNCTION json_each(document text, path text DEFAULT '$') RETURNS TABLE(key text, value text, type text)
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
      SELECT key, CASE jsonb_typeof(element)
        WHEN 'string' THEN element #>> '{}' WHEN 'null' THEN NULL ELSE element::text END,
        CASE jsonb_typeof(element) WHEN 'string' THEN 'text' ELSE jsonb_typeof(element) END
      FROM (SELECT jsonb_path_query_first(document::jsonb, path::jsonpath) AS root) AS doc,
      LATERAL (
        SELECT (ordinality - 1)::text AS key, element
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(root) = 'array' THEN root ELSE '[]'::jsonb END)
          WITH ORDINALITY AS elements(element, ordinality)
        UNION ALL
        SELECT key, value FROM jsonb_each(CASE WHEN jsonb_typeof(root) = 'object' THEN root ELSE '{}'::jsonb END)
      ) AS entries
    $$`,
  `CREATE FUNCTION "json_array"(value text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$ SELECT jsonb_build_array(value)::text $$`,
  `CREATE FUNCTION json_insert(document text, path text, value text) RETURNS text
    LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$ BEGIN
      IF path <> '$[#]' THEN RAISE EXCEPTION 'Unsupported JSON insert path'; END IF;
      RETURN (document::jsonb || jsonb_build_array(value))::text;
    END $$`,
  `CREATE FUNCTION json_array_append_value(state jsonb, value jsonb) RETURNS jsonb
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT COALESCE(state, '[]'::jsonb) || jsonb_build_array(value) $$`,
  `CREATE AGGREGATE json_group_array(jsonb) (SFUNC = json_array_append_value, STYPE = jsonb, INITCOND = '[]')`,
  `CREATE FUNCTION json_array_append_value(state jsonb, value json) RETURNS jsonb
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT json_array_append_value(state, value::jsonb) $$`,
  `CREATE AGGREGATE json_group_array(json) (SFUNC = json_array_append_value, STYPE = jsonb, INITCOND = '[]')`,
  `CREATE FUNCTION instr(haystack text, needle text) RETURNS integer
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$ SELECT position(needle IN haystack) $$`,
  `CREATE FUNCTION julianday(value text) RETURNS double precision LANGUAGE plpgsql STABLE STRICT AS $$ BEGIN
    RETURN extract(epoch FROM value::timestamptz) / 86400.0 + 2440587.5;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN NULL;
  END $$`,
  `CREATE SEQUENCE application_event_sequence AS bigint MAXVALUE 9007199254740991`,
  `CREATE FUNCTION next_application_sequence() RETURNS bigint LANGUAGE plpgsql VOLATILE AS $$ BEGIN
    PERFORM pg_advisory_xact_lock(hashtext(current_schema()), 1);
    RETURN nextval('application_event_sequence');
  END $$`,
];
