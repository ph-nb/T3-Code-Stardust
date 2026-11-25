-- Generated from the shipping PostgreSQL schema. Regenerate with apps/server/scripts/export-rust-schema.ts.

CREATE FUNCTION json_valid(document text) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$ BEGIN
      IF document IS NULL THEN RETURN false; END IF;
      PERFORM document::jsonb; RETURN true;
    EXCEPTION WHEN invalid_text_representation THEN RETURN false; END $$;

CREATE FUNCTION json_extract(document text, path text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
      SELECT CASE jsonb_typeof(value)
        WHEN 'null' THEN NULL WHEN 'boolean' THEN CASE WHEN value = 'true'::jsonb THEN '1' ELSE '0' END
        WHEN 'string' THEN value #>> '{}' ELSE value::text END
      FROM (SELECT jsonb_path_query_first(document::jsonb, path::jsonpath) AS value) AS extracted
    $$;

CREATE FUNCTION json_type(document text, path text DEFAULT '$') RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
      SELECT CASE jsonb_typeof(value)
        WHEN 'string' THEN 'text'
        WHEN 'boolean' THEN value::text
        WHEN 'number' THEN CASE WHEN value::text ~ '^-?[0-9]+$' THEN 'integer' ELSE 'real' END
        ELSE jsonb_typeof(value) END
      FROM (SELECT jsonb_path_query_first(document::jsonb, path::jsonpath) AS value) AS extracted
    $$;

CREATE FUNCTION json_array_length(document text, path text DEFAULT '$') RETURNS integer
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
      SELECT CASE WHEN jsonb_typeof(value) = 'array' THEN jsonb_array_length(value)
        WHEN value IS NULL THEN NULL ELSE 0 END
      FROM (SELECT jsonb_path_query_first(document::jsonb, path::jsonpath) AS value) AS extracted
    $$;

CREATE FUNCTION "json"(document text) RETURNS jsonb
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$ SELECT document::jsonb $$;

CREATE FUNCTION json_key_path(path text) RETURNS text[]
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
      SELECT regexp_split_to_array(regexp_replace(regexp_replace(path, '^\$\.?', ''), '\[([0-9]+)\]', '.\1', 'g'), '\.')
    $$;

CREATE FUNCTION json_set(document text, path text, value jsonb) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
      SELECT jsonb_set(document::jsonb, json_key_path(path), COALESCE(value, 'null'::jsonb), true)::text
    $$;

CREATE FUNCTION json_set(document text, path text, value json) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT json_set(document, path, value::jsonb) $$;

CREATE FUNCTION json_set(document text, path text, value text) RETURNS text
      LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT json_set(document, path, to_jsonb(value)) $$;

CREATE FUNCTION json_set(document text, path text, value bigint) RETURNS text
      LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT json_set(document, path, to_jsonb(value)) $$;

CREATE FUNCTION json_set(document text, path text, value integer) RETURNS text
      LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT json_set(document, path, to_jsonb(value)) $$;

CREATE FUNCTION json_set(document text, path text, value numeric) RETURNS text
      LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT json_set(document, path, to_jsonb(value)) $$;

CREATE FUNCTION json_set(document text, path text, value text, second_path text, second_value bigint) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
      SELECT json_set(json_set(document, path, value), second_path, second_value)
    $$;

CREATE FUNCTION json_remove(document text, path text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$ SELECT (document::jsonb #- json_key_path(path))::text $$;

CREATE FUNCTION json_remove(document text, first_path text, second_path text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$ SELECT json_remove(json_remove(document, first_path), second_path) $$;

CREATE FUNCTION json_tree(document text, path text) RETURNS TABLE(value text, type text)
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
      SELECT CASE jsonb_typeof(node)
        WHEN 'string' THEN node #>> '{}' WHEN 'null' THEN NULL ELSE node::text END,
        CASE jsonb_typeof(node) WHEN 'string' THEN 'text' ELSE jsonb_typeof(node) END
      FROM jsonb_path_query(jsonb_path_query_first(document::jsonb, path::jsonpath), 'strict $.**') AS nodes(node)
    $$;

CREATE FUNCTION json_each(document text, path text DEFAULT '$') RETURNS TABLE(key text, value text, type text)
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
    $$;

CREATE FUNCTION "json_array"(value text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$ SELECT jsonb_build_array(value)::text $$;

CREATE FUNCTION json_insert(document text, path text, value text) RETURNS text
    LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$ BEGIN
      IF path <> '$[#]' THEN RAISE EXCEPTION 'Unsupported JSON insert path'; END IF;
      RETURN (document::jsonb || jsonb_build_array(value))::text;
    END $$;

CREATE FUNCTION json_array_append_value(state jsonb, value jsonb) RETURNS jsonb
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT COALESCE(state, '[]'::jsonb) || jsonb_build_array(value) $$;

CREATE AGGREGATE json_group_array(jsonb) (SFUNC = json_array_append_value, STYPE = jsonb, INITCOND = '[]');

CREATE FUNCTION json_array_append_value(state jsonb, value json) RETURNS jsonb
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT json_array_append_value(state, value::jsonb) $$;

CREATE AGGREGATE json_group_array(json) (SFUNC = json_array_append_value, STYPE = jsonb, INITCOND = '[]');

CREATE FUNCTION instr(haystack text, needle text) RETURNS integer
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$ SELECT position(needle IN haystack) $$;

CREATE FUNCTION julianday(value text) RETURNS double precision LANGUAGE plpgsql STABLE STRICT AS $$ BEGIN
    RETURN extract(epoch FROM value::timestamptz) / 86400.0 + 2440587.5;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN NULL;
  END $$;

CREATE SEQUENCE application_event_sequence AS bigint MAXVALUE 9007199254740991;

CREATE FUNCTION next_application_sequence() RETURNS bigint LANGUAGE plpgsql VOLATILE AS $$ BEGIN
    PERFORM pg_advisory_xact_lock(hashtext(current_schema()), 1);
    RETURN nextval('application_event_sequence');
  END $$;

CREATE TABLE scheduled_tasks (
      task_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      enabled BIGINT NOT NULL,
      schedule_json TEXT NOT NULL,
      project_id TEXT NOT NULL,
      thread_id TEXT,
      workspace_strategy_json TEXT NOT NULL,
      model_selection_json TEXT NOT NULL,
      runtime_mode TEXT NOT NULL,
      interaction_mode TEXT NOT NULL,
      created_by TEXT NOT NULL,
      creation_source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      next_run_at TEXT,
      last_run_at TEXT,
      last_run_status TEXT NOT NULL,
      last_run_error TEXT,
      run_count BIGINT NOT NULL
    , webhook_token TEXT, webhook_secret TEXT, last_run_webhook_delivery_id TEXT, thread_mode TEXT NOT NULL DEFAULT 'new_thread', rowid BIGSERIAL NOT NULL UNIQUE);

CREATE TABLE auth_connect_devices (
      proof_key_thumbprint TEXT PRIMARY KEY,
      client_json TEXT,
      approved_at TEXT NOT NULL
    , rowid BIGSERIAL NOT NULL UNIQUE);

CREATE TABLE auth_pairing_links (
      id TEXT PRIMARY KEY,
      credential TEXT NOT NULL UNIQUE,
      method TEXT NOT NULL,
      scopes TEXT NOT NULL,
      subject TEXT NOT NULL,
      label TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      revoked_at TEXT
    , proof_key_thumbprint TEXT, requires_connect_approval BIGINT NOT NULL DEFAULT 0, requested_client_json TEXT, connect_denied BIGINT NOT NULL DEFAULT 0, rowid BIGSERIAL NOT NULL UNIQUE);

CREATE TABLE auth_sessions (
      session_id TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      scopes TEXT NOT NULL,
      method TEXT NOT NULL,
      client_label TEXT,
      client_ip_address TEXT,
      client_user_agent TEXT,
      client_device_type TEXT NOT NULL DEFAULT 'unknown',
      client_os TEXT,
      client_browser TEXT,
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_connected_at TEXT,
      revoked_at TEXT
    , client_surface TEXT, client_app_version TEXT, proof_key_thumbprint TEXT, rowid BIGSERIAL NOT NULL UNIQUE);

CREATE TABLE issue_tracker_bindings (
      project_id TEXT PRIMARY KEY,
      tracker TEXT NOT NULL,
      scope TEXT NOT NULL,
      updated_at TEXT NOT NULL
    , additional_scopes TEXT NOT NULL DEFAULT '[]', rowid BIGSERIAL NOT NULL UNIQUE);

CREATE TABLE mcp_app_model_context (
      thread_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      server TEXT NOT NULL,
      tool TEXT NOT NULL,
      text TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, item_id)
    , rowid BIGSERIAL NOT NULL UNIQUE);

CREATE TABLE orchestration_command_receipts (
      command_id TEXT PRIMARY KEY,
      aggregate_kind TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      accepted_at TEXT NOT NULL,
      result_sequence BIGINT NOT NULL,
      status TEXT NOT NULL,
      error TEXT
    , command_type TEXT NOT NULL DEFAULT 'legacy', rowid BIGSERIAL NOT NULL UNIQUE);

CREATE TABLE orchestration_events (
      sequence BIGINT PRIMARY KEY DEFAULT next_application_sequence(),
      event_id TEXT NOT NULL UNIQUE,
      aggregate_kind TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      stream_version BIGINT NOT NULL,
      event_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      command_id TEXT,
      causation_event_id TEXT,
      correlation_id TEXT,
      actor_kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    , application_event_version BIGINT NOT NULL DEFAULT 1);

CREATE TABLE orchestration_v2_command_receipts (
      command_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      command_type TEXT NOT NULL,
      accepted_at TEXT NOT NULL,
      result_sequence BIGINT NOT NULL,
      status TEXT NOT NULL,
      error TEXT
    , rowid BIGSERIAL NOT NULL UNIQUE);

CREATE TABLE "orchestration_v2_effect_outbox" (
      effect_id TEXT PRIMARY KEY,
      command_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      effect_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')
      ),
      attempt_count BIGINT NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL,
      lease_owner TEXT,
      lease_expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      last_error TEXT
    , rowid BIGSERIAL NOT NULL UNIQUE);

CREATE TABLE orchestration_v2_events (
      sequence BIGSERIAL PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE,
      command_id TEXT,
      thread_id TEXT NOT NULL,
      run_id TEXT,
      node_id TEXT,
      provider TEXT,
      raw_event_id TEXT,
      event_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    , driver TEXT, provider_instance_id TEXT);

CREATE TABLE orchestration_v2_legacy_imports (
      thread_id TEXT PRIMARY KEY,
      source_updated_at TEXT NOT NULL,
      shell_imported_at TEXT NOT NULL,
      transcript_imported_at TEXT,
      imported_message_count BIGINT NOT NULL DEFAULT 0,
      last_error TEXT
    , rowid BIGSERIAL NOT NULL UNIQUE);

CREATE TABLE orchestration_v2_projection_checkpoint_scopes (
      scope_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      run_id TEXT,
      node_id TEXT NOT NULL,
      parent_scope_id TEXT,
      provider_thread_id TEXT,
      kind TEXT NOT NULL,
      ordinal_within_parent BIGINT NOT NULL,
      advances_app_run_count BIGINT NOT NULL,
      created_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    , rowid BIGSERIAL NOT NULL UNIQUE);

CREATE TABLE orchestration_v2_projection_checkpoints (
      checkpoint_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      run_id TEXT,
      node_id TEXT NOT NULL,
      parent_checkpoint_id TEXT,
      ordinal_within_scope BIGINT NOT NULL,
      app_run_ordinal BIGINT,
      status TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    , rowid BIGSERIAL NOT NULL UNIQUE);

CREATE TABLE orchestration_v2_projection_context_handoffs (
      context_handoff_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      target_run_id TEXT NOT NULL,
      to_provider_thread_id TEXT NOT NULL,
      strategy TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    , rowid BIGSERIAL NOT NULL UNIQUE);

CREATE TABLE orchestration_v2_projection_context_transfers (
      context_transfer_id TEXT PRIMARY KEY,
      source_thread_id TEXT NOT NULL,
      target_thread_id TEXT NOT NULL,
      target_run_id TEXT,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      source_provider TEXT,
      target_provider TEXT,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    , source_provider_instance_id TEXT, target_provider_instance_id TEXT, rowid BIGSERIAL NOT NULL UNIQUE);

CREATE TABLE orchestration_v2_projection_messages (
      message_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      run_id TEXT,
      node_id TEXT,
      role TEXT NOT NULL,
      streaming BIGINT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    , search_text TEXT, rowid BIGSERIAL NOT NULL UNIQUE);

CREATE TABLE orchestration_v2_projection_metadata (
      projection_name TEXT PRIMARY KEY,
      schema_version BIGINT NOT NULL,
      last_sequence BIGINT NOT NULL,
      updated_at TEXT NOT NULL
    , rowid BIGSERIAL NOT NULL UNIQUE);

CREATE TABLE orchestration_v2_projection_nodes (
      node_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      run_id TEXT,
      parent_node_id TEXT,
      root_node_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      provider_thread_id TEXT,
      provider_turn_id TEXT,
      runtime_request_id TEXT,
      checkpoint_scope_id TEXT,
      started_at TEXT,
      completed_at TEXT,
      payload_json TEXT NOT NULL
    , rowid BIGSERIAL NOT NULL UNIQUE);

CREATE TABLE orchestration_v2_projection_plans (
      plan_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      run_id TEXT,
      node_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL
    , rowid BIGSERIAL NOT NULL UNIQUE);

CREATE TABLE orchestration_v2_projection_provider_session_bindings (
      provider_session_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      PRIMARY KEY (provider_session_id, thread_id)
    , rowid BIGSERIAL NOT NULL UNIQUE);

CREATE TABLE orchestration_v2_projection_provider_sessions (
      provider_session_id TEXT PRIMARY KEY,
      thread_id TEXT,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      model TEXT,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    , driver TEXT, provider_instance_id TEXT, rowid BIGSERIAL NOT NULL UNIQUE);

CREATE TABLE orchestration_v2_projection_provider_threads (
      provider_thread_id TEXT PRIMARY KEY,
      thread_id TEXT,
      owner_node_id TEXT,
      provider TEXT NOT NULL,
      provider_session_id TEXT,
      status TEXT NOT NULL,
      first_run_ordinal BIGINT,
      last_run_ordinal BIGINT,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    , driver TEXT, provider_instance_id TEXT, rowid BIGSERIAL NOT NULL UNIQUE);

CREATE TABLE orchestration_v2_projection_provider_turns (
      provider_turn_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      provider_thread_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      run_attempt_id TEXT,
      ordinal BIGINT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      payload_json TEXT NOT NULL
    , rowid BIGSERIAL NOT NULL UNIQUE);

CREATE TABLE orchestration_v2_projection_run_attempts (
      attempt_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      attempt_ordinal BIGINT NOT NULL,
      root_node_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_thread_id TEXT NOT NULL,
      provider_turn_id TEXT,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL
    , provider_instance_id TEXT, rowid BIGSERIAL NOT NULL UNIQUE);

CREATE TABLE orchestration_v2_projection_runs (
      run_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      ordinal BIGINT NOT NULL,
      provider TEXT NOT NULL,
      provider_thread_id TEXT,
      status TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      completed_at TEXT,
      payload_json TEXT NOT NULL
    , provider_instance_id TEXT, rowid BIGSERIAL NOT NULL UNIQUE);

CREATE TABLE orchestration_v2_projection_runtime_requests (
      runtime_request_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      provider_turn_id TEXT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      payload_json TEXT NOT NULL
    , rowid BIGSERIAL NOT NULL UNIQUE);

CREATE TABLE orchestration_v2_projection_subagents (
      subagent_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      run_id TEXT,
      parent_node_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_thread_id TEXT,
      child_thread_id TEXT,
      origin TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    , driver TEXT, provider_instance_id TEXT, completion_delivery_state TEXT, rowid BIGSERIAL NOT NULL UNIQUE);

CREATE TABLE orchestration_v2_projection_thread_item_counts (
      thread_id TEXT PRIMARY KEY,
      item_count BIGINT NOT NULL
    , rowid BIGSERIAL NOT NULL UNIQUE);

CREATE TABLE orchestration_v2_projection_threads (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      default_provider TEXT NOT NULL,
      runtime_mode TEXT NOT NULL,
      interaction_mode TEXT NOT NULL,
      active_provider_thread_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      deleted_at TEXT,
      payload_json TEXT NOT NULL
    , provider_instance_id TEXT, rowid BIGSERIAL NOT NULL UNIQUE);

CREATE TABLE orchestration_v2_projection_turn_item_counts (
      thread_id TEXT NOT NULL,
      run_key TEXT NOT NULL,
      item_count BIGINT NOT NULL,
      PRIMARY KEY (thread_id, run_key)
    , rowid BIGSERIAL NOT NULL UNIQUE);

CREATE TABLE orchestration_v2_projection_turn_items (
      turn_item_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      run_id TEXT,
      node_id TEXT,
      provider_thread_id TEXT,
      provider_turn_id TEXT,
      parent_item_id TEXT,
      ordinal BIGINT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    , inline_work_output BIGINT NOT NULL DEFAULT 0, rowid BIGSERIAL NOT NULL UNIQUE);

CREATE TABLE orchestration_v2_thread_launch_workflows (
      command_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      worktree_path TEXT,
      branch TEXT,
      setup_committed BIGINT NOT NULL DEFAULT 0,
      thread_committed BIGINT NOT NULL DEFAULT 0,
      message_committed BIGINT NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    , rowid BIGSERIAL NOT NULL UNIQUE);

CREATE TABLE orchestration_v2_turn_item_positions (
      thread_id TEXT NOT NULL,
      turn_item_id TEXT NOT NULL,
      ordinal BIGINT NOT NULL,
      PRIMARY KEY (thread_id, turn_item_id),
      UNIQUE (thread_id, ordinal)
    , rowid BIGSERIAL NOT NULL UNIQUE);

CREATE TABLE peer_environment_links (
      environment_id TEXT PRIMARY KEY,
      secret_name TEXT NOT NULL,
      label TEXT NOT NULL,
      urls_json TEXT NOT NULL,
      access TEXT NOT NULL,
      linked_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_reached_at TEXT,
      last_error TEXT
    , fenced BIGINT NOT NULL DEFAULT 0, rowid BIGSERIAL NOT NULL UNIQUE);

CREATE TABLE projection_projects (
      project_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      workspace_root TEXT NOT NULL,
      scripts_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    , default_model_selection_json TEXT, default_thread_env_mode TEXT, favicon_path TEXT, auto_pull BIGINT NOT NULL DEFAULT 0, project_icon_json TEXT, pinned_at TEXT, archived_at TEXT, has_custom_title BIGINT NOT NULL DEFAULT 0, tracked_folders_json TEXT NOT NULL DEFAULT '[]', rowid BIGSERIAL NOT NULL UNIQUE);

CREATE TABLE projection_thread_messages (
      message_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      is_streaming BIGINT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    , attachments_json TEXT, context_json TEXT, rowid BIGSERIAL NOT NULL UNIQUE);

CREATE TABLE projection_thread_pull_requests (
      thread_id TEXT NOT NULL,
      host TEXT NOT NULL,
      repository TEXT NOT NULL,
      number BIGINT NOT NULL,
      url TEXT NOT NULL,
      source TEXT NOT NULL,
      linked_at TEXT NOT NULL,
      snapshot_json TEXT,
      stack_json TEXT,
      PRIMARY KEY (thread_id, host, repository, number)
    , rowid BIGSERIAL NOT NULL UNIQUE);

CREATE TABLE projection_thread_sessions (
      thread_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      provider_name TEXT,
      provider_session_id TEXT,
      provider_thread_id TEXT,
      active_turn_id TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL
    , runtime_mode TEXT NOT NULL DEFAULT 'full-access', provider_instance_id TEXT, rowid BIGSERIAL NOT NULL UNIQUE);

CREATE TABLE projection_threads (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      branch TEXT,
      worktree_path TEXT,
      latest_turn_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    , runtime_mode TEXT NOT NULL DEFAULT 'full-access', interaction_mode TEXT NOT NULL DEFAULT 'default', model_selection_json TEXT, archived_at TEXT, latest_user_message_at TEXT, pending_approval_count BIGINT NOT NULL DEFAULT 0, pending_user_input_count BIGINT NOT NULL DEFAULT 0, has_actionable_proposed_plan BIGINT NOT NULL DEFAULT 0, settled_override TEXT, settled_at TEXT, snoozed_until TEXT, snoozed_at TEXT, title_regeneration_request_id TEXT, title_regeneration_started_at TEXT, pinned_at TEXT, pin_order_key TEXT, linked_pull_request_json TEXT, unsettled_at TEXT, branch_pull_request_json TEXT, active_order_key TEXT, title_state_json TEXT, auto_settle_disabled_at TEXT, rowid BIGSERIAL NOT NULL UNIQUE);

CREATE TABLE provider_session_runtime (
      thread_id TEXT PRIMARY KEY,
      provider_name TEXT NOT NULL,
      adapter_key TEXT NOT NULL,
      runtime_mode TEXT NOT NULL DEFAULT 'full-access',
      status TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      resume_cursor_json TEXT,
      runtime_payload_json TEXT
    , provider_instance_id TEXT, rowid BIGSERIAL NOT NULL UNIQUE);

CREATE TABLE pull_request_files_viewed (
      provider TEXT NOT NULL,
      host TEXT NOT NULL,
      repository TEXT NOT NULL,
      number BIGINT NOT NULL,
      viewer TEXT NOT NULL,
      path TEXT NOT NULL,
      revision TEXT,
      viewed_at TEXT NOT NULL,
      PRIMARY KEY (provider, host, repository, number, viewer, path)
    , rowid BIGSERIAL NOT NULL UNIQUE);

CREATE TABLE pull_request_review_guides (
      host TEXT NOT NULL,
      repository TEXT NOT NULL,
      number BIGINT NOT NULL,
      guide_json TEXT NOT NULL,
      PRIMARY KEY (host, repository, number)
    , rowid BIGSERIAL NOT NULL UNIQUE);

CREATE TABLE scheduled_task_webhook_deliveries (
      delivery_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      received_at TEXT NOT NULL,
      method TEXT NOT NULL,
      query TEXT NOT NULL,
      headers_json TEXT NOT NULL,
      body TEXT NOT NULL,
      body_bytes BIGINT NOT NULL,
      body_truncated BIGINT NOT NULL,
      outcome TEXT NOT NULL,
      signature_verified BIGINT NOT NULL,
      missing_fields_json TEXT NOT NULL,
      rendered_prompt TEXT,
      error TEXT
    , rowid BIGSERIAL NOT NULL UNIQUE);

CREATE TABLE scheduled_task_webhook_pending (
    delivery_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES scheduled_tasks(task_id) ON DELETE CASCADE,
    coalesce_key TEXT NOT NULL,
    due_at BIGINT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    task_json TEXT NOT NULL,
    request_json TEXT NOT NULL,
    delivery_ids_json TEXT NOT NULL
  , rowid BIGSERIAL NOT NULL UNIQUE);

CREATE TABLE scheduled_task_webhook_relay_deliveries (
      relay_delivery_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      seen_at TEXT NOT NULL
    , rowid BIGSERIAL NOT NULL UNIQUE);

CREATE TABLE scheduled_task_webhook_replay_keys (
    task_id TEXT NOT NULL REFERENCES scheduled_tasks(task_id) ON DELETE CASCADE,
    replay_key TEXT NOT NULL,
    delivery_id TEXT NOT NULL,
    expires_at BIGINT NOT NULL,
    PRIMARY KEY (task_id, replay_key)
  , rowid BIGSERIAL NOT NULL UNIQUE);

CREATE TABLE task_folders (
      root TEXT PRIMARY KEY,
      real_root TEXT NOT NULL,
      project_id TEXT NOT NULL,
      project_root TEXT NOT NULL,
      anchor TEXT NOT NULL,
      project_path TEXT NOT NULL,
      project_is_worktree BIGINT NOT NULL,
      repositories_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    , rowid BIGSERIAL NOT NULL UNIQUE);

CREATE INDEX idx_auth_pairing_links_active
    ON auth_pairing_links(revoked_at, consumed_at, expires_at);

CREATE INDEX idx_auth_sessions_active
    ON auth_sessions(revoked_at, expires_at, issued_at);

CREATE INDEX idx_orch_command_receipts_aggregate
    ON orchestration_command_receipts(aggregate_kind, aggregate_id);

CREATE INDEX idx_orch_command_receipts_sequence
    ON orchestration_command_receipts(result_sequence);

CREATE INDEX idx_orch_events_command_id
    ON orchestration_events(command_id);

CREATE INDEX idx_orch_events_stream_sequence
    ON orchestration_events(aggregate_kind, stream_id, sequence);

CREATE UNIQUE INDEX idx_orch_events_stream_version
    ON orchestration_events(aggregate_kind, stream_id, stream_version);

CREATE INDEX idx_orchestration_events_agent_stream_sequence
    ON orchestration_events(stream_id, sequence)
    WHERE application_event_version = 2 AND aggregate_kind = 'thread';

CREATE INDEX idx_orchestration_events_application_high_water
    ON orchestration_events(sequence)
    WHERE aggregate_kind = 'project'
      OR (application_event_version = 2 AND aggregate_kind = 'thread');

CREATE INDEX idx_orchestration_events_application_sequence
    ON orchestration_events(application_event_version, sequence);

CREATE INDEX idx_projection_projects_updated_at
    ON projection_projects(updated_at);

CREATE INDEX idx_projection_projects_workspace_root_deleted_at
    ON projection_projects(workspace_root, deleted_at);

CREATE INDEX idx_projection_thread_messages_thread_created_id
    ON projection_thread_messages(thread_id, created_at, message_id);

CREATE INDEX idx_projection_thread_pull_requests_pr
    ON projection_thread_pull_requests(host, repository, number);

CREATE INDEX idx_projection_thread_sessions_instance
    ON projection_thread_sessions(provider_instance_id);

CREATE INDEX idx_projection_thread_sessions_provider_session
    ON projection_thread_sessions(provider_session_id);

CREATE INDEX idx_projection_threads_project_archived_at
    ON projection_threads(project_id, archived_at);

CREATE INDEX idx_projection_threads_project_deleted_created
    ON projection_threads(project_id, deleted_at, created_at);

CREATE INDEX idx_projection_threads_shell_active
    ON projection_threads(deleted_at, archived_at, project_id, created_at, thread_id);

CREATE INDEX idx_projection_threads_shell_archived
    ON projection_threads(deleted_at, archived_at, project_id, thread_id);

CREATE INDEX idx_provider_session_runtime_instance
    ON provider_session_runtime(provider_instance_id);

CREATE INDEX idx_provider_session_runtime_provider
    ON provider_session_runtime(provider_name);

CREATE INDEX idx_provider_session_runtime_status
    ON provider_session_runtime(status);

CREATE INDEX idx_scheduled_task_webhook_deliveries_task
    ON scheduled_task_webhook_deliveries(task_id, received_at);

CREATE INDEX idx_scheduled_task_webhook_relay_deliveries_seen
    ON scheduled_task_webhook_relay_deliveries(seen_at);

CREATE INDEX idx_scheduled_tasks_due
    ON scheduled_tasks(enabled, next_run_at)
    WHERE enabled = 1 AND next_run_at IS NOT NULL;

CREATE INDEX idx_scheduled_tasks_project
    ON scheduled_tasks(project_id, updated_at);

CREATE INDEX idx_task_folders_real_root ON task_folders (real_root);

CREATE INDEX idx_webhook_pending_due ON scheduled_task_webhook_pending(state, due_at);

CREATE UNIQUE INDEX idx_webhook_pending_key
    ON scheduled_task_webhook_pending(task_id, coalesce_key) WHERE state = 'pending';

CREATE INDEX idx_webhook_replay_delivery ON scheduled_task_webhook_replay_keys(delivery_id);

CREATE INDEX idx_webhook_replay_expiry ON scheduled_task_webhook_replay_keys(expires_at);

CREATE INDEX orchestration_events_v2_created_threads_idx
    ON orchestration_events(stream_id)
    WHERE application_event_version = 2
      AND aggregate_kind = 'thread'
      AND event_type = 'thread.created';

CREATE INDEX orchestration_v2_command_receipts_thread_sequence_idx ON orchestration_v2_command_receipts(thread_id, result_sequence);

CREATE INDEX orchestration_v2_effect_outbox_claim_idx
    ON orchestration_v2_effect_outbox(status, available_at, lease_expires_at, created_at);

CREATE INDEX orchestration_v2_effect_outbox_command_idx
    ON orchestration_v2_effect_outbox(command_id, effect_id);

CREATE INDEX orchestration_v2_effect_outbox_thread_status_idx
    ON orchestration_v2_effect_outbox(thread_id, status, effect_type);

CREATE INDEX orchestration_v2_events_command_idx ON orchestration_v2_events(command_id, sequence);

CREATE INDEX orchestration_v2_events_instance_sequence_idx ON orchestration_v2_events(provider_instance_id, sequence);

CREATE INDEX orchestration_v2_events_node_sequence_idx ON orchestration_v2_events(node_id, sequence);

CREATE INDEX orchestration_v2_events_raw_event_idx ON orchestration_v2_events(raw_event_id);

CREATE INDEX orchestration_v2_events_run_sequence_idx ON orchestration_v2_events(run_id, sequence);

CREATE INDEX orchestration_v2_events_thread_sequence_idx ON orchestration_v2_events(thread_id, sequence);

CREATE INDEX orchestration_v2_events_thread_type_sequence_idx ON orchestration_v2_events(thread_id, event_type, sequence);

CREATE INDEX orchestration_v2_legacy_imports_pending_transcript_idx
    ON orchestration_v2_legacy_imports(transcript_imported_at, shell_imported_at, thread_id);

CREATE INDEX orchestration_v2_projection_checkpoint_scopes_parent_idx ON orchestration_v2_projection_checkpoint_scopes(parent_scope_id);

CREATE INDEX orchestration_v2_projection_checkpoint_scopes_thread_idx ON orchestration_v2_projection_checkpoint_scopes(thread_id);

CREATE INDEX orchestration_v2_projection_checkpoints_parent_idx ON orchestration_v2_projection_checkpoints(parent_checkpoint_id);

CREATE UNIQUE INDEX orchestration_v2_projection_checkpoints_scope_ordinal_idx ON orchestration_v2_projection_checkpoints(scope_id, ordinal_within_scope);

CREATE INDEX orchestration_v2_projection_checkpoints_thread_idx ON orchestration_v2_projection_checkpoints(thread_id);

CREATE INDEX orchestration_v2_projection_context_handoffs_target_run_idx ON orchestration_v2_projection_context_handoffs(target_run_id);

CREATE INDEX orchestration_v2_projection_context_handoffs_thread_idx ON orchestration_v2_projection_context_handoffs(thread_id);

CREATE INDEX orchestration_v2_projection_context_transfers_fork_idx
    ON orchestration_v2_projection_context_transfers(target_thread_id)
    WHERE type = 'fork';

CREATE INDEX orchestration_v2_projection_context_transfers_source_thread_status_idx
    ON orchestration_v2_projection_context_transfers(source_thread_id, status);

CREATE INDEX orchestration_v2_projection_context_transfers_target_run_idx ON orchestration_v2_projection_context_transfers(target_run_id);

CREATE INDEX orchestration_v2_projection_context_transfers_target_thread_idx ON orchestration_v2_projection_context_transfers(target_thread_id, status);

CREATE INDEX orchestration_v2_projection_messages_deferred_command_idx
    ON orchestration_v2_projection_messages(thread_id, created_at, message_id)
    WHERE role = 'user' AND (
  lower(btrim(json_extract(payload_json, '$.text'), ' 	
                 　﻿')) = '/compact'
  OR btrim(json_extract(payload_json, '$.text'), ' 	
                 　﻿') LIKE '/goal%'
);

CREATE INDEX orchestration_v2_projection_messages_delegated_task_idx
    ON orchestration_v2_projection_messages(thread_id, created_at, message_id)
    WHERE role = 'user' AND json_valid(payload_json) AND (
  json_extract(payload_json, '$.notification.source.kind') = 'monitor'
  OR json_extract(payload_json, '$.delegatedCompletion') IS NOT NULL
);

CREATE INDEX orchestration_v2_projection_messages_latest_user_idx
    ON orchestration_v2_projection_messages(thread_id, updated_at DESC, message_id DESC)
    WHERE role = 'user';

CREATE INDEX orchestration_v2_projection_messages_node_idx ON orchestration_v2_projection_messages(node_id);

CREATE INDEX orchestration_v2_projection_messages_run_idx ON orchestration_v2_projection_messages(run_id);

CREATE INDEX orchestration_v2_projection_messages_thread_created_idx ON orchestration_v2_projection_messages(thread_id, created_at, message_id);

CREATE INDEX orchestration_v2_projection_nodes_live_idx
    ON orchestration_v2_projection_nodes(thread_id)
    WHERE status IN ('pending', 'starting', 'running', 'waiting');

CREATE INDEX orchestration_v2_projection_nodes_parent_idx ON orchestration_v2_projection_nodes(parent_node_id);

CREATE INDEX orchestration_v2_projection_nodes_provider_turn_idx ON orchestration_v2_projection_nodes(provider_turn_id);

CREATE INDEX orchestration_v2_projection_nodes_settled_leaf_idx
    ON orchestration_v2_projection_nodes(
      thread_id,
      (kind IN ('tool_call', 'assistant_message', 'reasoning')
        AND status IN ('completed', 'interrupted', 'failed', 'cancelled', 'rolled_back')
        AND run_id IS NOT NULL)
    );

CREATE INDEX orchestration_v2_projection_nodes_thread_run_idx ON orchestration_v2_projection_nodes(thread_id, run_id);

CREATE INDEX orchestration_v2_projection_plans_run_idx ON orchestration_v2_projection_plans(run_id);

CREATE INDEX orchestration_v2_projection_plans_thread_idx ON orchestration_v2_projection_plans(thread_id);

CREATE INDEX orchestration_v2_projection_provider_session_bindings_thread_idx
    ON orchestration_v2_projection_provider_session_bindings(thread_id);

CREATE INDEX orchestration_v2_projection_provider_sessions_instance_status_idx ON orchestration_v2_projection_provider_sessions(provider_instance_id, status);

CREATE INDEX orchestration_v2_projection_provider_sessions_provider_status_idx ON orchestration_v2_projection_provider_sessions(provider, status);

CREATE INDEX orchestration_v2_projection_provider_sessions_thread_idx ON orchestration_v2_projection_provider_sessions(thread_id);

CREATE INDEX orchestration_v2_projection_provider_threads_instance_status_idx ON orchestration_v2_projection_provider_threads(provider_instance_id, status);

CREATE INDEX orchestration_v2_projection_provider_threads_owner_idx ON orchestration_v2_projection_provider_threads(owner_node_id);

CREATE INDEX orchestration_v2_projection_provider_threads_pending_tasks_idx
    ON orchestration_v2_projection_provider_threads(thread_id)
    WHERE (CASE WHEN json_valid(payload_json)
      THEN json_array_length(payload_json, '$.pendingBackgroundTasks') > 0
      ELSE false END);

CREATE INDEX orchestration_v2_projection_provider_threads_session_idx ON orchestration_v2_projection_provider_threads(provider_session_id);

CREATE INDEX orchestration_v2_projection_provider_threads_thread_idx ON orchestration_v2_projection_provider_threads(thread_id);

CREATE INDEX orchestration_v2_projection_provider_turns_attempt_idx
    ON orchestration_v2_projection_provider_turns(run_attempt_id);

CREATE INDEX orchestration_v2_projection_provider_turns_thread_idx ON orchestration_v2_projection_provider_turns(thread_id);

CREATE UNIQUE INDEX orchestration_v2_projection_provider_turns_thread_ordinal_idx ON orchestration_v2_projection_provider_turns(provider_thread_id, ordinal);

CREATE INDEX orchestration_v2_projection_requests_recovery_idx
    ON orchestration_v2_projection_runtime_requests(thread_id)
    WHERE status = 'pending';

CREATE UNIQUE INDEX orchestration_v2_projection_run_attempts_run_ordinal_idx ON orchestration_v2_projection_run_attempts(run_id, attempt_ordinal);

CREATE INDEX orchestration_v2_projection_run_attempts_thread_idx ON orchestration_v2_projection_run_attempts(thread_id, run_id);

CREATE INDEX orchestration_v2_projection_runs_delegated_delivery_idx
    ON orchestration_v2_projection_runs(thread_id)
    WHERE (CASE WHEN json_valid(payload_json)
      THEN json_type(payload_json, '$.delegatedCompletion.delivery') = 'object'
      ELSE false END);

CREATE INDEX orchestration_v2_projection_runs_delegated_task_idx
    ON orchestration_v2_projection_runs(thread_id, json_extract(payload_json, '$.delegatedTaskId'))
    WHERE json_valid(payload_json) AND json_extract(payload_json, '$.delegatedTaskId') IS NOT NULL;

CREATE INDEX orchestration_v2_projection_runs_hidden_items_idx
    ON orchestration_v2_projection_runs(thread_id, status, run_id)
    WHERE status IN ('rolled_back', 'queued', 'cancelled');

CREATE INDEX orchestration_v2_projection_runs_last_executed_idx
    ON orchestration_v2_projection_runs(
      thread_id, (completed_at IS NULL) DESC, completed_at DESC, ordinal DESC, run_id DESC
    )
    WHERE status <> 'queued'
      AND NOT (status = 'cancelled' AND json_extract(payload_json, '$.startedAt') IS NULL);

CREATE INDEX orchestration_v2_projection_runs_provider_thread_idx ON orchestration_v2_projection_runs(provider_thread_id);

CREATE INDEX orchestration_v2_projection_runs_recovery_idx
    ON orchestration_v2_projection_runs(status, thread_id)
    WHERE status IN ('queued', 'preparing', 'starting', 'running', 'waiting');

CREATE INDEX orchestration_v2_projection_runs_run_status_idx
    ON orchestration_v2_projection_runs(run_id, status);

CREATE UNIQUE INDEX orchestration_v2_projection_runs_thread_ordinal_idx ON orchestration_v2_projection_runs(thread_id, ordinal);

CREATE INDEX orchestration_v2_projection_runs_thread_status_idx ON orchestration_v2_projection_runs(thread_id, status);

CREATE INDEX orchestration_v2_projection_runtime_requests_provider_turn_idx ON orchestration_v2_projection_runtime_requests(provider_turn_id);

CREATE INDEX orchestration_v2_projection_runtime_requests_thread_status_idx ON orchestration_v2_projection_runtime_requests(thread_id, status);

CREATE INDEX orchestration_v2_projection_subagents_child_thread_idx ON orchestration_v2_projection_subagents(child_thread_id);

CREATE INDEX orchestration_v2_projection_subagents_parent_node_idx ON orchestration_v2_projection_subagents(parent_node_id);

CREATE INDEX orchestration_v2_projection_subagents_provider_thread_idx ON orchestration_v2_projection_subagents(provider_thread_id);

CREATE INDEX orchestration_v2_projection_subagents_routable_idx
    ON orchestration_v2_projection_subagents(thread_id, subagent_id)
    WHERE origin = 'provider_native' AND status = 'completed';

CREATE INDEX orchestration_v2_projection_subagents_settled_idx
    ON orchestration_v2_projection_subagents(thread_id, status, completion_delivery_state, run_id);

CREATE INDEX orchestration_v2_projection_subagents_thread_idx ON orchestration_v2_projection_subagents(thread_id, started_at, subagent_id);

CREATE INDEX orchestration_v2_projection_threads_active_shell_idx
    ON orchestration_v2_projection_threads(
      updated_at,
      thread_id,
      project_id,
      (CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.lineage.relationshipToParent') END),
      (CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.lineage.parentThreadId') END),
      (CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.lineage.rootThreadId') END),
      (CASE WHEN json_valid(payload_json) THEN CAST(json_extract(payload_json, '$.lineage.sideChat') AS BIGINT) END),
      (CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.settledOverride') END),
      (CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.settledAt') END),
      (CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.pinnedAt') END),
      (CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.pinOrderKey') END),
      (CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.snoozedUntil') END),
      (CASE WHEN json_valid(payload_json) THEN json_type(payload_json, '$.pullRequests[0]') END)
    )
    WHERE deleted_at IS NULL AND archived_at IS NULL;

CREATE INDEX orchestration_v2_projection_threads_project_updated_idx ON orchestration_v2_projection_threads(project_id, updated_at);

CREATE INDEX orchestration_v2_projection_threads_root_thread_idx
    ON orchestration_v2_projection_threads(
      (CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.lineage.rootThreadId') END)
    );

CREATE INDEX orchestration_v2_projection_threads_subagent_result_idx
    ON orchestration_v2_projection_threads(
      thread_id, json_extract(payload_json, '$.lineage.parentThreadId')
    )
    WHERE (CASE WHEN json_valid(payload_json) THEN
      json_extract(payload_json, '$.lineage.relationshipToParent') = 'subagent'
      AND json_extract(payload_json, '$.lineage.parentThreadId') IS NOT NULL
      AND json_extract(payload_json, '$.forkedFrom.type') = 'node'
      ELSE false END);

CREATE INDEX orchestration_v2_projection_threads_worktree_path_idx
    ON orchestration_v2_projection_threads(
      (CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.worktreePath') END)
    );

CREATE INDEX orchestration_v2_projection_turn_items_active_ordinal_idx
    ON orchestration_v2_projection_turn_items(thread_id, ordinal, turn_item_id)
    WHERE status IN ('pending', 'running', 'waiting');

CREATE INDEX orchestration_v2_projection_turn_items_active_run_idx
    ON orchestration_v2_projection_turn_items(thread_id, run_id)
    WHERE status IN ('pending', 'running', 'waiting');

CREATE INDEX orchestration_v2_projection_turn_items_conversation_idx
    ON orchestration_v2_projection_turn_items(thread_id, ordinal, type, run_id)
    WHERE type NOT IN (
      'command_execution', 'reasoning', 'file_change', 'file_search', 'web_search', 'dynamic_tool'
    );

CREATE INDEX orchestration_v2_projection_turn_items_failed_error_idx
    ON orchestration_v2_projection_turn_items(
      thread_id, run_id, node_id, updated_at DESC, ordinal DESC, turn_item_id DESC
    )
    WHERE type = 'error' AND status = 'failed';

CREATE INDEX orchestration_v2_projection_turn_items_message_ordinal_idx
    ON orchestration_v2_projection_turn_items(
      thread_id, json_extract(payload_json, '$.messageId'), ordinal
    )
    WHERE type IN ('user_message', 'assistant_message') AND json_valid(payload_json);

CREATE INDEX orchestration_v2_projection_turn_items_node_ordinal_idx ON orchestration_v2_projection_turn_items(node_id, ordinal);

CREATE INDEX orchestration_v2_projection_turn_items_provider_turn_idx ON orchestration_v2_projection_turn_items(provider_turn_id);

CREATE INDEX orchestration_v2_projection_turn_items_queued_input_idx
    ON orchestration_v2_projection_turn_items(run_id)
    WHERE type = 'user_message'
      AND json_valid(payload_json)
      AND json_extract(payload_json, '$.inputIntent') = 'queued_turn';

CREATE INDEX orchestration_v2_projection_turn_items_recovery_idx
    ON orchestration_v2_projection_turn_items(thread_id)
    WHERE type IN ('command_execution', 'dynamic_tool', 'subagent')
      AND status IN ('pending', 'running', 'waiting');

CREATE INDEX orchestration_v2_projection_turn_items_run_ordinal_idx ON orchestration_v2_projection_turn_items(run_id, ordinal);

CREATE INDEX orchestration_v2_projection_turn_items_shell_pending_idx
    ON orchestration_v2_projection_turn_items(thread_id, run_id)
    WHERE type IN ('command_execution', 'dynamic_tool', 'subagent')
      AND status NOT IN ('completed', 'interrupted', 'failed', 'cancelled');

CREATE INDEX orchestration_v2_projection_turn_items_stop_request_idx
    ON orchestration_v2_projection_turn_items(thread_id, run_id)
    WHERE type = 'run_interrupt_request';

CREATE INDEX orchestration_v2_projection_turn_items_thread_ordinal_idx ON orchestration_v2_projection_turn_items(thread_id, ordinal, turn_item_id);

CREATE INDEX orchestration_v2_projection_turn_items_thread_run_idx
    ON orchestration_v2_projection_turn_items(thread_id, run_id);

CREATE INDEX orchestration_v2_projection_turn_items_thread_type_idx
    ON orchestration_v2_projection_turn_items(thread_id, type, status);

CREATE INDEX orchestration_v2_projection_turn_items_usage_limit_idx
    ON orchestration_v2_projection_turn_items(thread_id)
    WHERE type = 'error' AND status = 'failed'
      AND (CASE WHEN json_valid(payload_json) THEN
        json_extract(payload_json, '$.failure.class') = 'usage_limit'
        ELSE false END);

CREATE INDEX orchestration_v2_projection_turn_items_user_message_idx
    ON orchestration_v2_projection_turn_items(thread_id, ordinal, turn_item_id)
    WHERE type = 'user_message';

CREATE INDEX orchestration_v2_projection_turn_items_waiting_link_idx
    ON orchestration_v2_projection_turn_items(thread_id, updated_at DESC, turn_item_id DESC)
    WHERE type = 'link_request' AND status = 'waiting';

CREATE INDEX orchestration_v2_provider_turns_codex_native_id_idx
    ON orchestration_v2_projection_provider_turns (
      json_extract(payload_json, '$.nativeTurnRef.nativeId')
    )
    WHERE json_extract(payload_json, '$.nativeTurnRef.driver') = 'codex';

CREATE FUNCTION orchestration_v2_thread_item_counts_count_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF old.run_key = ''
      OR EXISTS (SELECT 1 FROM orchestration_v2_projection_runs WHERE run_id = old.run_key) THEN UPDATE orchestration_v2_projection_thread_item_counts
      SET item_count = item_count - old.item_count
      WHERE thread_id = old.thread_id;
      DELETE FROM orchestration_v2_projection_thread_item_counts
      WHERE thread_id = old.thread_id AND item_count <= 0;
     END IF; RETURN NULL; END $$;

CREATE TRIGGER orchestration_v2_thread_item_counts_count_delete AFTER DELETE ON orchestration_v2_projection_turn_item_counts FOR EACH ROW EXECUTE FUNCTION orchestration_v2_thread_item_counts_count_delete_fn();

CREATE FUNCTION orchestration_v2_thread_item_counts_count_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF new.run_key = ''
      OR EXISTS (SELECT 1 FROM orchestration_v2_projection_runs WHERE run_id = new.run_key) THEN INSERT INTO orchestration_v2_projection_thread_item_counts (thread_id, item_count)
      VALUES (new.thread_id, new.item_count)
      ON CONFLICT (thread_id) DO UPDATE SET item_count = orchestration_v2_projection_thread_item_counts.item_count + excluded.item_count;
     END IF; RETURN NULL; END $$;

CREATE TRIGGER orchestration_v2_thread_item_counts_count_insert AFTER INSERT ON orchestration_v2_projection_turn_item_counts FOR EACH ROW EXECUTE FUNCTION orchestration_v2_thread_item_counts_count_insert_fn();

CREATE FUNCTION orchestration_v2_thread_item_counts_count_update_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE orchestration_v2_projection_thread_item_counts
      SET item_count = item_count - old.item_count
      WHERE thread_id = old.thread_id
        AND (old.run_key = ''
          OR EXISTS (SELECT 1 FROM orchestration_v2_projection_runs WHERE run_id = old.run_key));
      INSERT INTO orchestration_v2_projection_thread_item_counts (thread_id, item_count)
      SELECT new.thread_id, new.item_count
      WHERE new.run_key = ''
        OR EXISTS (SELECT 1 FROM orchestration_v2_projection_runs WHERE run_id = new.run_key)
      ON CONFLICT (thread_id) DO UPDATE SET item_count = orchestration_v2_projection_thread_item_counts.item_count + excluded.item_count;
      DELETE FROM orchestration_v2_projection_thread_item_counts
      WHERE thread_id = old.thread_id AND item_count <= 0;
     RETURN NULL; END $$;

CREATE TRIGGER orchestration_v2_thread_item_counts_count_update AFTER UPDATE ON orchestration_v2_projection_turn_item_counts FOR EACH ROW EXECUTE FUNCTION orchestration_v2_thread_item_counts_count_update_fn();

CREATE FUNCTION orchestration_v2_thread_item_counts_run_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE orchestration_v2_projection_thread_item_counts
      SET item_count = item_count - (
        SELECT COUNT(*)
        FROM orchestration_v2_projection_turn_items item
        WHERE item.run_id = old.run_id
          AND item.thread_id = orchestration_v2_projection_thread_item_counts.thread_id
      )
      WHERE thread_id IN (
        SELECT thread_id FROM orchestration_v2_projection_turn_items WHERE run_id = old.run_id
      );
      DELETE FROM orchestration_v2_projection_thread_item_counts
      WHERE item_count <= 0 AND thread_id IN (
        SELECT thread_id FROM orchestration_v2_projection_turn_items WHERE run_id = old.run_id
      );
     RETURN NULL; END $$;

CREATE TRIGGER orchestration_v2_thread_item_counts_run_delete AFTER DELETE ON orchestration_v2_projection_runs FOR EACH ROW EXECUTE FUNCTION orchestration_v2_thread_item_counts_run_delete_fn();

CREATE FUNCTION orchestration_v2_thread_item_counts_run_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO orchestration_v2_projection_thread_item_counts (thread_id, item_count)
      SELECT thread_id, COUNT(*)
      FROM orchestration_v2_projection_turn_items
      WHERE run_id = new.run_id
      GROUP BY thread_id
      ON CONFLICT (thread_id) DO UPDATE SET item_count = orchestration_v2_projection_thread_item_counts.item_count + excluded.item_count;
     RETURN NULL; END $$;

CREATE TRIGGER orchestration_v2_thread_item_counts_run_insert AFTER INSERT ON orchestration_v2_projection_runs FOR EACH ROW EXECUTE FUNCTION orchestration_v2_thread_item_counts_run_insert_fn();

CREATE FUNCTION orchestration_v2_turn_item_counts_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE orchestration_v2_projection_turn_item_counts SET item_count = item_count - 1
      WHERE thread_id = old.thread_id AND run_key = COALESCE(old.run_id, '');
      DELETE FROM orchestration_v2_projection_turn_item_counts
      WHERE thread_id = old.thread_id AND run_key = COALESCE(old.run_id, '') AND item_count <= 0;
     RETURN NULL; END $$;

CREATE TRIGGER orchestration_v2_turn_item_counts_delete AFTER DELETE ON orchestration_v2_projection_turn_items FOR EACH ROW EXECUTE FUNCTION orchestration_v2_turn_item_counts_delete_fn();

CREATE FUNCTION orchestration_v2_turn_item_counts_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO orchestration_v2_projection_turn_item_counts (thread_id, run_key, item_count)
      VALUES (new.thread_id, COALESCE(new.run_id, ''), 1)
      ON CONFLICT (thread_id, run_key) DO UPDATE SET item_count = orchestration_v2_projection_turn_item_counts.item_count + 1;
     RETURN NULL; END $$;

CREATE TRIGGER orchestration_v2_turn_item_counts_insert AFTER INSERT ON orchestration_v2_projection_turn_items FOR EACH ROW EXECUTE FUNCTION orchestration_v2_turn_item_counts_insert_fn();

CREATE FUNCTION orchestration_v2_turn_item_counts_update_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF old.thread_id IS DISTINCT FROM new.thread_id OR old.run_id IS DISTINCT FROM new.run_id THEN UPDATE orchestration_v2_projection_turn_item_counts SET item_count = item_count - 1
      WHERE thread_id = old.thread_id AND run_key = COALESCE(old.run_id, '');
      DELETE FROM orchestration_v2_projection_turn_item_counts
      WHERE thread_id = old.thread_id AND run_key = COALESCE(old.run_id, '') AND item_count <= 0;
      INSERT INTO orchestration_v2_projection_turn_item_counts (thread_id, run_key, item_count)
      VALUES (new.thread_id, COALESCE(new.run_id, ''), 1)
      ON CONFLICT (thread_id, run_key) DO UPDATE SET item_count = orchestration_v2_projection_turn_item_counts.item_count + 1;
     END IF; RETURN NULL; END $$;

CREATE TRIGGER orchestration_v2_turn_item_counts_update AFTER UPDATE OF thread_id, run_id ON orchestration_v2_projection_turn_items FOR EACH ROW EXECUTE FUNCTION orchestration_v2_turn_item_counts_update_fn();

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

CREATE FUNCTION stardust_search_fold(value text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $stardust_fold$
      SELECT lower(translate(value, ' ¨ª¯²³´µ¸¹ºÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞàáâãäåçèéêëìíîïñòóôõöùúûüýÿĀāĂăĄąĆćĈĉĊċČčĎďĐĒēĔĕĖėĘęĚěĜĝĞğĠġĢģĤĥĦĨĩĪīĬĭĮįİĴĵĶķĹĺĻļĽľŁŃńŅņŇňŊŌōŎŏŐőŒŔŕŖŗŘřŚśŜŝŞşŠšŢţŤťŦŨũŪūŬŭŮůŰűŲųŴŵŶŷŸŹźŻżŽžſƁƂƄƆƇƉƊƋƎƏƐƑƓƔƖƗƘƜƝƟƠơƢƤƦƧƩƬƮƯưƱƲƳƵƷƸƼǍǎǏǐǑǒǓǔǕǖǗǘǙǚǛǜǞǟǠǡǢǣǤǦǧǨǩǪǫǬǭǮǯǰǴǵǶǷǸǹǺǻǼǽǾǿȀȁȂȃȄȅȆȇȈȉȊȋȌȍȎȏȐȑȒȓȔȕȖȗȘșȚțȜȞȟȠȢȤȦȧȨȩȪȫȬȭȮȯȰȱȲȳȺȻȽȾɁɃɄɅɆɈɊɌɎʰʱʲʳʴʵʶʷʸ˘˙˚˛˜˝ˠˡˢˣˤͰͲʹͶͺ;Ϳ΄΅Ά·ΈΉΊΌΎΏΐΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩΪΫάέήίΰςϊϋόύώϏϐϑϒϓϔϕϖϘϚϜϞϠϢϤϦϨϪϬϮϰϱϲϴϵϷϹϺϽϾϿЀЁЂЃЄЅІЇЈЉЊЋЌЍЎЏАБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯйѐёѓїќѝўѠѢѤѦѨѪѬѮѰѲѴѶѷѸѺѼѾҀҊҌҎҐҒҔҖҘҚҜҞҠҢҤҦҨҪҬҮҰҲҴҶҸҺҼҾӀӁӂӃӅӇӉӋӍӐӑӒӓӔӖӗӘӚӛӜӝӞӟӠӢӣӤӥӦӧӨӪӫӬӭӮӯӰӱӲӳӴӵӶӸӹӺӼӾԀԂԄԆԈԊԌԎԐԒԔԖԘԚԜԞԠԢԤԦԨԪԬԮԱԲԳԴԵԶԷԸԹԺԻԼԽԾԿՀՁՂՃՄՅՆՇՈՉՊՋՌՍՎՏՐՑՒՓՔՕՖآأؤإئۀۂۓऩऱऴक़ख़ग़ज़ड़ढ़फ़य़ড়ঢ়য়ਲ਼ਸ਼ਖ਼ਗ਼ਜ਼ਫ਼ଡ଼ଢ଼ஔำຳ༌གྷཌྷདྷབྷཛྷཀྵဦႠႡႢႣႤႥႦႧႨႩႪႫႬႭႮႯႰႱႲႳႴႵႶႷႸႹႺႻႼႽႾႿჀჁჂჃჄჅჇჍჼᎠᎡᎢᎣᎤᎥᎦᎧᎨᎩᎪᎫᎬᎭᎮᎯᎰᎱᎲᎳᎴᎵᎶᎷᎸᎹᎺᎻᎼᎽᎾᎿᏀᏁᏂᏃᏄᏅᏆᏇᏈᏉᏊᏋᏌᏍᏎᏏᏐᏑᏒᏓᏔᏕᏖᏗᏘᏙᏚᏛᏜᏝᏞᏟᏠᏡᏢᏣᏤᏥᏦᏧᏨᏩᏪᏫᏬᏭᏮᏯᏰᏱᏲᏳᏴᏵᬆᬈᬊᬌᬎᬒᲉᲐᲑᲒᲓᲔᲕᲖᲗᲘᲙᲚᲛᲜᲝᲞᲟᲠᲡᲢᲣᲤᲥᲦᲧᲨᲩᲪᲫᲬᲭᲮᲯᲰᲱᲲᲳᲴᲵᲶᲷᲸᲹᲺᲽᲾᲿᴬᴭᴮᴰᴱᴲᴳᴴᴵᴶᴷᴸᴹᴺᴼᴽᴾᴿᵀᵁᵂᵃᵄᵅᵆᵇᵈᵉᵊᵋᵌᵍᵏᵐᵑᵒᵓᵔᵕᵖᵗᵘᵙᵚᵛᵜᵝᵞᵟᵠᵡᵢᵣᵤᵥᵦᵧᵨᵩᵪᵸᶛᶜᶝᶞᶟᶠᶡᶢᶣᶤᶥᶦᶧᶨᶩᶪᶫᶬᶭᶮᶯᶰᶱᶲᶳᶴᶵᶶᶷᶸᶹᶺᶻᶼᶽᶾᶿḀḁḂḃḄḅḆḇḈḉḊḋḌḍḎḏḐḑḒḓḔḕḖḗḘḙḚḛḜḝḞḟḠḡḢḣḤḥḦḧḨḩḪḫḬḭḮḯḰḱḲḳḴḵḶḷḸḹḺḻḼḽḾḿṀṁṂṃṄṅṆṇṈṉṊṋṌṍṎṏṐṑṒṓṔṕṖṗṘṙṚṛṜṝṞṟṠṡṢṣṤṥṦṧṨṩṪṫṬṭṮṯṰṱṲṳṴṵṶṷṸṹṺṻṼṽṾṿẀẁẂẃẄẅẆẇẈẉẊẋẌẍẎẏẐẑẒẓẔẕẖẗẘẙẛẞẠạẢảẤấẦầẨẩẪẫẬậẮắẰằẲẳẴẵẶặẸẹẺẻẼẽẾếỀềỂểỄễỆệỈỉỊịỌọỎỏỐốỒồỔổỖỗỘộỚớỜờỞởỠỡỢợỤụỦủỨứỪừỬửỮữỰựỲỳỴỵỶỷỸỹỺỼỾἀἁἂἃἄἅἆἇἈἉἊἋἌἍἎἏἐἑἒἓἔἕἘἙἚἛἜἝἠἡἢἣἤἥἦἧἨἩἪἫἬἭἮἯἰἱἲἳἴἵἶἷἸἹἺἻἼἽἾἿὀὁὂὃὄὅὈὉὊὋὌὍὐὑὒὓὔὕὖὗὙὛὝὟὠὡὢὣὤὥὦὧὨὩὪὫὬὭὮὯὰάὲέὴήὶίὸόὺύὼώᾀᾁᾂᾃᾄᾅᾆᾇᾈᾉᾊᾋᾌᾍᾎᾏᾐᾑᾒᾓᾔᾕᾖᾗᾘᾙᾚᾛᾜᾝᾞᾟᾠᾡᾢᾣᾤᾥᾦᾧᾨᾩᾪᾫᾬᾭᾮᾯᾰᾱᾲᾳᾴᾶᾷᾸᾹᾺΆᾼ᾽ι᾿῀῁ῂῃῄῆῇῈΈῊΉῌ῍῎῏ῐῑῒΐῖῗῘῙῚΊ῝῞῟ῠῡῢΰῤῥῦῧῨῩῪΎῬ῭΅`ῲῳῴῶῷῸΌῺΏῼ´῾           ‑‗‘’․ ‾ ⁰ⁱ⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿ₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₒₓₔₕₖₗₘₙₚₛₜℂℇℊℋℌℍℎℏℐℑℒℓℕℙℚℛℜℝℤΩℨKÅℬℭℯℰℱℲℳℴℵℶℷℸℹℼℽℾℿ⅀ⅅⅆⅇⅈⅉⅠⅤⅩⅬⅭⅮⅯⅰⅴⅹⅼⅽⅾⅿↃ↚↛↮⇍⇎⇏∄∉∌∤∦≁≄≇≉≠≢≭≮≯≰≱≴≵≸≹⊀⊁⊄⊅⊈⊉⊬⊭⊮⊯⋠⋡⋢⋣⋪⋫⋬⋭〈〉①②③④⑤⑥⑦⑧⑨ⒶⒷⒸⒹⒺⒻⒼⒽⒾⒿⓀⓁⓂⓃⓄⓅⓆⓇⓈⓉⓊⓋⓌⓍⓎⓏⓐⓑⓒⓓⓔⓕⓖⓗⓘⓙⓚⓛⓜⓝⓞⓟⓠⓡⓢⓣⓤⓥⓦⓧⓨⓩ⓪⫝̸ⰀⰁⰂⰃⰄⰅⰆⰇⰈⰉⰊⰋⰌⰍⰎⰏⰐⰑⰒⰓⰔⰕⰖⰗⰘⰙⰚⰛⰜⰝⰞⰟⰠⰡⰢⰣⰤⰥⰦⰧⰨⰩⰪⰫⰬⰭⰮⰯⱠⱢⱣⱤⱧⱩⱫⱭⱮⱯⱰⱲⱵⱼⱽⱾⱿⲀⲂⲄⲆⲈⲊⲌⲎⲐⲒⲔⲖⲘⲚⲜⲞⲠⲢⲤⲦⲨⲪⲬⲮⲰⲲⲴⲶⲸⲺⲼⲾⳀⳂⳄⳆⳈⳊⳌⳎⳐⳒⳔⳖⳘⳚⳜⳞⳠⳢⳫⳭⳲⵯ⺟⻳⼀⼁⼂⼃⼄⼅⼆⼇⼈⼉⼊⼋⼌⼍⼎⼏⼐⼑⼒⼓⼔⼕⼖⼗⼘⼙⼚⼛⼜⼝⼞⼟⼠⼡⼢⼣⼤⼥⼦⼧⼨⼩⼪⼫⼬⼭⼮⼯⼰⼱⼲⼳⼴⼵⼶⼷⼸⼹⼺⼻⼼⼽⼾⼿⽀⽁⽂⽃⽄⽅⽆⽇⽈⽉⽊⽋⽌⽍⽎⽏⽐⽑⽒⽓⽔⽕⽖⽗⽘⽙⽚⽛⽜⽝⽞⽟⽠⽡⽢⽣⽤⽥⽦⽧⽨⽩⽪⽫⽬⽭⽮⽯⽰⽱⽲⽳⽴⽵⽶⽷⽸⽹⽺⽻⽼⽽⽾⽿⾀⾁⾂⾃⾄⾅⾆⾇⾈⾉⾊⾋⾌⾍⾎⾏⾐⾑⾒⾓⾔⾕⾖⾗⾘⾙⾚⾛⾜⾝⾞⾟⾠⾡⾢⾣⾤⾥⾦⾧⾨⾩⾪⾫⾬⾭⾮⾯⾰⾱⾲⾳⾴⾵⾶⾷⾸⾹⾺⾻⾼⾽⾾⾿⿀⿁⿂⿃⿄⿅⿆⿇⿈⿉⿊⿋⿌⿍⿎⿏⿐⿑⿒⿓⿔⿕　〶〸〹〺がぎぐげござじずぜぞだぢづでどばぱびぴぶぷべぺぼぽゔ゛゜ゞガギグゲゴザジズゼゾダヂヅデドバパビピブプベペボポヴヷヸヹヺヾㄱㄲㄳㄴㄵㄶㄷㄸㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅃㅄㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣㅤㅥㅦㅧㅨㅩㅪㅫㅬㅭㅮㅯㅰㅱㅲㅳㅴㅵㅶㅷㅸㅹㅺㅻㅼㅽㅾㅿㆀㆁㆂㆃㆄㆅㆆㆇㆈㆉㆊㆋㆌㆍㆎ㆒㆓㆔㆕㆖㆗㆘㆙㆚㆛㆜㆝㆞㆟㉄㉅㉆㉇㉠㉡㉢㉣㉤㉥㉦㉧㉨㉩㉪㉫㉬㉭㊀㊁㊂㊃㊄㊅㊆㊇㊈㊉㊊㊋㊌㊍㊎㊏㊐㊑㊒㊓㊔㊕㊖㊗㊘㊙㊚㊛㊜㊝㊞㊟㊠㊡㊢㊣㊤㊥㊦㊧㊨㊩㊪㊫㊬㊭㊮㊯㊰㋐㋑㋒㋓㋔㋕㋖㋗㋘㋙㋚㋛㋜㋝㋞㋟㋠㋡㋢㋣㋤㋥㋦㋧㋨㋩㋪㋫㋬㋭㋮㋯㋰㋱㋲㋳㋴㋵㋶㋷㋸㋹㋺㋻㋼㋽㋾ꙀꙂꙄꙆꙈꙊꙌꙎꙐꙒꙔꙖꙘꙚꙜꙞꙠꙢꙤꙦꙨꙪꙬꚀꚂꚄꚆꚈꚊꚌꚎꚐꚒꚔꚖꚘꚚꚜꚝꜢꜤꜦꜨꜪꜬꜮꜲꜴꜶꜸꜺꜼꜾꝀꝂꝄꝆꝈꝊꝌꝎꝐꝒꝔꝖꝘꝚꝜꝞꝠꝢꝤꝦꝨꝪꝬꝮꝰꝹꝻꝽꝾꞀꞂꞄꞆꞋꞍꞐꞒꞖꞘꞚꞜꞞꞠꞢꞤꞦꞨꞪꞫꞬꞭꞮꞰꞱꞲꞳꞴꞶꞸꞺꞼꞾꟀꟂꟄꟅꟆꟇꟉꟋꟌ꟎Ꟑ꟒꟔ꟖꟘꟚꟜ꟱ꟲꟳꟴꟵꟸꟹꭜꭝꭞꭟꭩ豈更車賈滑串句龜龜契金喇奈懶癩羅蘿螺裸邏樂洛烙珞落酪駱亂卵欄爛蘭鸞嵐濫藍襤拉臘蠟廊朗浪狼郎來冷勞擄櫓爐盧老蘆虜路露魯鷺碌祿綠菉錄鹿論壟弄籠聾牢磊賂雷壘屢樓淚漏累縷陋勒肋凜凌稜綾菱陵讀拏樂諾丹寧怒率異北磻便復不泌數索參塞省葉說殺辰沈拾若掠略亮兩凉梁糧良諒量勵呂女廬旅濾礪閭驪麗黎力曆歷轢年憐戀撚漣煉璉秊練聯輦蓮連鍊列劣咽烈裂說廉念捻殮簾獵令囹寧嶺怜玲瑩羚聆鈴零靈領例禮醴隸惡了僚寮尿料樂燎療蓼遼龍暈阮劉杻柳流溜琉留硫紐類六戮陸倫崙淪輪律慄栗率隆利吏履易李梨泥理痢罹裏裡里離匿溺吝燐璘藺隣鱗麟林淋臨立笠粒狀炙識什茶刺切度拓糖宅洞暴輻行降見廓兀嗀塚晴凞猪益礼神祥福靖精羽蘒諸逸都飯飼館鶴郞隷侮僧免勉勤卑喝嘆器塀墨層屮悔慨憎懲敏既暑梅海渚漢煮爫琢碑社祉祈祐祖祝禍禎穀突節練縉繁署者臭艹艹著褐視謁謹賓贈辶逸難響頻恵舘並况全侀充冀勇勺喝啕喙嗢塚墳奄奔婢嬨廒廙彩徭惘慎愈憎慠懲戴揄搜摒敖晴朗望杖歹殺流滛滋漢瀞煮瞧爵犯猪瑱甆画瘝瘟益盛直睊着磌窱節类絛練缾者荒華蝹襁覆視調諸請謁諾諭謹變贈輸遲醙鉶陼難靖韛響頋頻鬒龜㮝䀘䀹齃龎יִײַﬠﬡﬢﬣﬤﬥﬦﬧﬨ﬩שׁשׂשּׁשּׂאַאָאּבּגּדּהּוּזּטּיּךּכּלּמּנּסּףּפּצּקּרּשּתּוֹבֿכֿפֿﭐﭑﭒﭓﭔﭕﭖﭗﭘﭙﭚﭛﭜﭝﭞﭟﭠﭡﭢﭣﭤﭥﭦﭧﭨﭩﭪﭫﭬﭭﭮﭯﭰﭱﭲﭳﭴﭵﭶﭷﭸﭹﭺﭻﭼﭽﭾﭿﮀﮁﮂﮃﮄﮅﮆﮇﮈﮉﮊﮋﮌﮍﮎﮏﮐﮑﮒﮓﮔﮕﮖﮗﮘﮙﮚﮛﮜﮝﮞﮟﮠﮡﮢﮣﮤﮥﮦﮧﮨﮩﮪﮫﮬﮭﮮﮯﮰﮱﯓﯔﯕﯖﯗﯘﯙﯚﯛﯜﯞﯟﯠﯡﯢﯣﯤﯥﯦﯧﯨﯩﯼﯽﯾﯿﱛﱜﱝﱞﱟﱠﱡﱢﱣﲐﳙﳲﳳﳴﴼﴽ︐︑︒︓︔︕︖︗︘︱︲︳︴︵︶︷︸︹︺︻︼︽︾︿﹀﹁﹂﹃﹄﹇﹈﹉﹊﹋﹌﹍﹎﹏﹐﹑﹒﹔﹕﹖﹗﹘﹙﹚﹛﹜﹝﹞﹟﹠﹡﹢﹣﹤﹥﹦﹨﹩﹪﹫ﹰﹱﹲﹴﹶﹷﹸﹹﹺﹻﹼﹽﹾﹿﺀﺁﺂﺃﺄﺅﺆﺇﺈﺉﺊﺋﺌﺍﺎﺏﺐﺑﺒﺓﺔﺕﺖﺗﺘﺙﺚﺛﺜﺝﺞﺟﺠﺡﺢﺣﺤﺥﺦﺧﺨﺩﺪﺫﺬﺭﺮﺯﺰﺱﺲﺳﺴﺵﺶﺷﺸﺹﺺﺻﺼﺽﺾﺿﻀﻁﻂﻃﻄﻅﻆﻇﻈﻉﻊﻋﻌﻍﻎﻏﻐﻑﻒﻓﻔﻕﻖﻗﻘﻙﻚﻛﻜﻝﻞﻟﻠﻡﻢﻣﻤﻥﻦﻧﻨﻩﻪﻫﻬﻭﻮﻯﻰﻱﻲﻳﻴ！＂＃＄％＆＇（）＊＋，－．／０１２３４５６７８９：；＜＝＞？＠ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ［＼］＾＿｀ａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ｛｜｝～｟｠｡｢｣､･ｦｧｨｩｪｫｬｭｮｯｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝﾠﾡﾢﾣﾤﾥﾦﾧﾨﾩﾪﾫﾬﾭﾮﾯﾰﾱﾲﾳﾴﾵﾶﾷﾸﾹﾺﾻﾼﾽﾾￂￃￄￅￆￇￊￋￌￍￎￏￒￓￔￕￖￗￚￛￜ￠￡￢￣￤￥￦￨￩￪￫￬￭￮', '  a 23 μ 1oaaaaaaæceeeeiiiiðnoooooøuuuuyþaaaaaaceeeeiiiinooooouuuuyyaaaaaaccccccccddđeeeeeeeeeegggggggghhħiiiiiiiiijjkkllllllłnnnnnnŋooooooœrrrrrrssssssssttttŧuuuuuuuuuuuuwwyyyzzzzzzsɓƃƅɔƈɖɗƌǝəɛƒɠɣɩɨƙɯɲɵooƣƥʀƨʃƭʈuuʊʋƴƶʒƹƽaaiioouuuuuuuuuuaaaaææǥggkkooooʒʒjggƕƿnnaaææøøaaaaeeeeiiiioooorrrruuuussttȝhhƞȣȥaaeeooooooooyyⱥȼƚⱦɂƀʉʌɇɉɋɍɏhɦjrɹɻʁwy      ɣlsxʕͱͳʹͷ ;ϳ  α·εηιουωιαβγδεζηθικλμνξοπρστυφχψωιυαεηιυσιυουωϗβθυυυφπϙϛϝϟϡϣϥϧϩϫϭϯκρσθεϸσϻͻͼͽееђгєѕііјљњћкиуџабвгдежзииклмнопрстуфхцчшщъыьэюяиеегікиуѡѣѥѧѩѫѭѯѱѳѵѵѵѹѻѽѿҁҋҍҏґғҕҗҙқҝҟҡңҥҧҩҫҭүұҳҵҷҹһҽҿӏжжӄӆӈӊӌӎааааӕееәәәжжззӡииииооөөөээууууууччӷыыӻӽӿԁԃԅԇԉԋԍԏԑԓԕԗԙԛԝԟԡԣԥԧԩԫԭԯաբգդեզէըթժիլխծկհձղճմյնշոչպջռսվտրցւփքօֆااوايەہےनरळकखगजडढफयডঢযਲਸਖਗਜਫଡଢஒาາ་གཌདབཛཀဥⴀⴁⴂⴃⴄⴅⴆⴇⴈⴉⴊⴋⴌⴍⴎⴏⴐⴑⴒⴓⴔⴕⴖⴗⴘⴙⴚⴛⴜⴝⴞⴟⴠⴡⴢⴣⴤⴥⴧⴭნꭰꭱꭲꭳꭴꭵꭶꭷꭸꭹꭺꭻꭼꭽꭾꭿꮀꮁꮂꮃꮄꮅꮆꮇꮈꮉꮊꮋꮌꮍꮎꮏꮐꮑꮒꮓꮔꮕꮖꮗꮘꮙꮚꮛꮜꮝꮞꮟꮠꮡꮢꮣꮤꮥꮦꮧꮨꮩꮪꮫꮬꮭꮮꮯꮰꮱꮲꮳꮴꮵꮶꮷꮸꮹꮺꮻꮼꮽꮾꮿᏸᏹᏺᏻᏼᏽᬅᬇᬉᬋᬍᬑᲊაბგდევზთიკლმნოპჟრსტუფქღყშჩცძწჭხჯჰჱჲჳჴჵჶჷჸჹჺჽჾჿaæbdeǝghijklmnoȣprtuwaɐɑᴂbdeəɛɜgkmŋoɔᴖᴗptuᴝɯvᴥβγδφχiruvβγρφχнɒcɕðɜfɟɡɥɨɩɪᵻʝɭᶅʟɱɰɲɳɴɵɸʂʃƫʉʊᴜʋʌzʐʑʒθaabbbbbbccddddddddddeeeeeeeeeeffgghhhhhhhhhhiiiikkkkkkllllllllmmmmmmnnnnnnnnoooooooopppprrrrrrrrssssssssssttttttttuuuuuuuuuuvvvvwwwwwwwwwwxxxxyyzzzzzzhtwysßaaaaaaaaaaaaaaaaaaaaaaaaeeeeeeeeeeeeeeeeiiiioooooooooooooooooooooooouuuuuuuuuuuuuuyyyyyyyyỻỽỿααααααααααααααααεεεεεεεεεεεεηηηηηηηηηηηηηηηηιιιιιιιιιιιιιιιιοοοοοοοοοοοουυυυυυυυυυυυωωωωωωωωωωωωωωωωααεεηηιιοουυωωααααααααααααααααηηηηηηηηηηηηηηηηωωωωωωωωωωωωωωωωαααααααααααα ι   ηηηηηεεηηη   ιιιιιιιιιι   υυυυρρυυυυυυρ  `ωωωωωοοωωω             ‐ ''''.   0i456789+−=()n0123456789+−=()aeoxəhklmnpstcɛghhhhħiillnpqrrrzωzkabceefⅎmoאבגדiπγγπ∑ddeijivxlcdmivxlcdmↄ←→↔⇐⇔⇒∃∈∋∣∥∼≃≅≈=≡≍<>≤≥≲≳≶≷≺≻⊂⊃⊆⊇⊢⊨⊩⊫≼≽⊑⊒⊲⊳⊴⊵〈〉123456789abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz0⫝ⰰⰱⰲⰳⰴⰵⰶⰷⰸⰹⰺⰻⰼⰽⰾⰿⱀⱁⱂⱃⱄⱅⱆⱇⱈⱉⱊⱋⱌⱍⱎⱏⱐⱑⱒⱓⱔⱕⱖⱗⱘⱙⱚⱛⱜⱝⱞⱟⱡɫᵽɽⱨⱪⱬɑɱɐɒⱳⱶjvȿɀⲁⲃⲅⲇⲉⲋⲍⲏⲑⲓⲕⲗⲙⲛⲝⲟⲡⲣⲥⲧⲩⲫⲭⲯⲱⲳⲵⲷⲹⲻⲽⲿⳁⳃⳅⳇⳉⳋⳍⳏⳑⳓⳕⳗⳙⳛⳝⳟⳡⳣⳬⳮⳳⵡ母龟一丨丶丿乙亅二亠人儿入八冂冖冫几凵刀力勹匕匚匸十卜卩厂厶又口囗土士夂夊夕大女子宀寸小尢尸屮山巛工己巾干幺广廴廾弋弓彐彡彳心戈戶手支攴文斗斤方无日曰月木欠止歹殳毋比毛氏气水火爪父爻爿片牙牛犬玄玉瓜瓦甘生用田疋疒癶白皮皿目矛矢石示禸禾穴立竹米糸缶网羊羽老而耒耳聿肉臣自至臼舌舛舟艮色艸虍虫血行衣襾見角言谷豆豕豸貝赤走足身車辛辰辵邑酉釆里金長門阜隶隹雨靑非面革韋韭音頁風飛食首香馬骨高髟鬥鬯鬲鬼魚鳥鹵鹿麥麻黃黍黑黹黽鼎鼓鼠鼻齊齒龍龜龠 〒十卄卅かきくけこさしすせそたちつてとははひひふふへへほほう  ゝカキクケコサシスセソタチツテトハハヒヒフフヘヘホホウワヰヱヲヽᄀᄁᆪᄂᆬᆭᄃᄄᄅᆰᆱᆲᆳᆴᆵᄚᄆᄇᄈᄡᄉᄊᄋᄌᄍᄎᄏᄐᄑ하ᅢᅣᅤᅥᅦᅧᅨᅩᅪᅫᅬᅭᅮᅯᅰᅱᅲᅳᅴᅵᅠᄔᄕᇇᇈᇌᇎᇓᇗᇙᄜᇝᇟᄝᄞᄠᄢᄣᄧᄩᄫᄬᄭᄮᄯᄲᄶᅀᅇᅌᇱᇲᅗᅘᅙᆄᆅᆈᆑᆒᆔᆞᆡ一二三四上中下甲乙丙丁天地人問幼文箏ᄀᄂᄃᄅᄆᄇᄉᄋᄌᄎᄏᄐᄑᄒ一二三四五六七八九十月火水木金土日株有社名特財祝労秘男女適優印注項休写正上中下左右医宗学監企資協夜アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヰヱヲꙁꙃꙅꙇꙉꙋꙍꙏꙑꙓꙕꙗꙙꙛꙝꙟꙡꙣꙥꙧꙩꙫꙭꚁꚃꚅꚇꚉꚋꚍꚏꚑꚓꚕꚗꚙꚛъьꜣꜥꜧꜩꜫꜭꜯꜳꜵꜷꜹꜻꜽꜿꝁꝃꝅꝇꝉꝋꝍꝏꝑꝓꝕꝗꝙꝛꝝꝟꝡꝣꝥꝧꝩꝫꝭꝯꝯꝺꝼᵹꝿꞁꞃꞅꞇꞌɥꞑꞓꞗꞙꞛꞝꞟꞡꞣꞥꞧꞩɦɜɡɬɪʞʇʝꭓꞵꞷꞹꞻꞽꞿꟁꟃꞔʂᶎꟈꟊɤꟍ꟏ꟑꟓꟕꟗꟙꟛƛscfqꟶħœꜧꬷɫꭒʍ豈更車賈滑串句龜龜契金喇奈懶癩羅蘿螺裸邏樂洛烙珞落酪駱亂卵欄爛蘭鸞嵐濫藍襤拉臘蠟廊朗浪狼郎來冷勞擄櫓爐盧老蘆虜路露魯鷺碌祿綠菉錄鹿論壟弄籠聾牢磊賂雷壘屢樓淚漏累縷陋勒肋凜凌稜綾菱陵讀拏樂諾丹寧怒率異北磻便復不泌數索參塞省葉說殺辰沈拾若掠略亮兩凉梁糧良諒量勵呂女廬旅濾礪閭驪麗黎力曆歷轢年憐戀撚漣煉璉秊練聯輦蓮連鍊列劣咽烈裂說廉念捻殮簾獵令囹寧嶺怜玲瑩羚聆鈴零靈領例禮醴隸惡了僚寮尿料樂燎療蓼遼龍暈阮劉杻柳流溜琉留硫紐類六戮陸倫崙淪輪律慄栗率隆利吏履易李梨泥理痢罹裏裡里離匿溺吝燐璘藺隣鱗麟林淋臨立笠粒狀炙識什茶刺切度拓糖宅洞暴輻行降見廓兀嗀塚晴凞猪益礼神祥福靖精羽蘒諸逸都飯飼館鶴郞隷侮僧免勉勤卑喝嘆器塀墨層屮悔慨憎懲敏既暑梅海渚漢煮爫琢碑社祉祈祐祖祝禍禎穀突節練縉繁署者臭艹艹著褐視謁謹賓贈辶逸難響頻恵舘並况全侀充冀勇勺喝啕喙嗢塚墳奄奔婢嬨廒廙彩徭惘慎愈憎慠懲戴揄搜摒敖晴朗望杖歹殺流滛滋漢瀞煮瞧爵犯猪瑱甆画瘝瘟益盛直睊着磌窱節类絛練缾者荒華蝹襁覆視調諸請謁諾諭謹變贈輸遲醙鉶陼難靖韛響頋頻鬒龜㮝䀘䀹齃龎יײעאדהכלםרת+ששששאאאבגדהוזטיךכלמנסףפצקרשתובכפٱٱٻٻٻٻپپپپڀڀڀڀٺٺٺٺٿٿٿٿٹٹٹٹڤڤڤڤڦڦڦڦڄڄڄڄڃڃڃڃچچچچڇڇڇڇڍڍڌڌڎڎڈڈژژڑڑککککگگگگڳڳڳڳڱڱڱڱںںڻڻڻڻەەہہہہھھھھےےےےڭڭڭڭۇۇۆۆۈۈۋۋۅۅۉۉېېېېىىییییذرى      ىهـــاا,、。:;!?〖〗—–__(){}〔〕【】《》〈〉「」『』[]    ___,、.;:?!—(){}〔〕#&*+-<>=\$%@ ـ   ـ ـ ـ ـ ـءااااووااييييااببببةةتتتتثثثثججججححححخخخخددذذررززسسسسششششصصصصضضضضططططظظظظععععغغغغففففققققككككللللممممننننههههووىىيييي!"#$%&''()*+,-./0123456789:;<=>?@abcdefghijklmnopqrstuvwxyz[\]^_`abcdefghijklmnopqrstuvwxyz{|}~⦅⦆。「」、・ヲァィゥェォャュョッーアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワンᅠᄀᄁᆪᄂᆬᆭᄃᄄᄅᆰᆱᆲᆳᆴᆵᄚᄆᄇᄈᄡᄉᄊᄋᄌᄍᄎᄏᄐᄑ하ᅢᅣᅤᅥᅦᅧᅨᅩᅪᅫᅬᅭᅮᅯᅰᅱᅲᅳᅴᅵ¢£¬ ¦¥₩│←↑→↓■○'))
    $stardust_fold$;

CREATE INDEX orchestration_v2_messages_text_trgm_idx
    ON orchestration_v2_projection_messages USING gin
      (stardust_search_fold(COALESCE(search_text, json_extract(payload_json, '$.text'))) public.gin_trgm_ops)
    WHERE streaming = 0;

CREATE TABLE stardust_storage_metadata (
    singleton integer PRIMARY KEY CHECK (singleton = 1), version integer NOT NULL,
    sqlite_migration integer NOT NULL, environment_id text NOT NULL,
    status text NOT NULL CHECK (status IN ('ready', 'awaiting-import')),
    imported_at text, source_sha256 text
  );

