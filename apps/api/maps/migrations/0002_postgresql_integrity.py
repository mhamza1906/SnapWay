"""PostgreSQL-only scope keys and immutable publication/snapshot guards.

SQLite remains an onboarding substitute, not a product integrity test backend.
Keep SQL self-contained here so historical migrations do not import live models.
"""

from django.db import migrations

# (child table, child columns, parent table, parent columns, constraint name)
SCOPE_LINKS = [
    (
        "maps_revision",
        "contribution_id,target_id",
        "maps_contribution",
        "id,target_id",
        "revision_contribution_scope_fk",
    ),
    (
        "maps_revision",
        "parent_id,target_id",
        "maps_revision",
        "id,target_id",
        "revision_parent_scope_fk",
    ),
    (
        "maps_contribution",
        "base_revision_id,target_id",
        "maps_revision",
        "id,target_id",
        "contribution_base_scope_fk",
    ),
    (
        "maps_contribution",
        "head_revision_id,id",
        "maps_revision",
        "id,contribution_id",
        "contribution_head_scope_fk",
    ),
    (
        "maps_asset",
        "source_asset_id,target_id",
        "maps_asset",
        "id,target_id",
        "asset_source_scope_fk",
    ),
    (
        "maps_revision",
        "source_asset_id,target_id",
        "maps_asset",
        "id,target_id",
        "revision_source_scope_fk",
    ),
    (
        "maps_revision",
        "standardized_asset_id,target_id",
        "maps_asset",
        "id,target_id",
        "revision_standardized_scope_fk",
    ),
    (
        "maps_room",
        "map_object_id,revision_id",
        "maps_mapobject",
        "id,revision_id",
        "room_object_scope_fk",
    ),
    ("maps_node", "room_id,revision_id", "maps_room", "id,revision_id", "node_room_scope_fk"),
    (
        "maps_node",
        "map_object_id,revision_id",
        "maps_mapobject",
        "id,revision_id",
        "node_object_scope_fk",
    ),
    ("maps_edge", "from_node_id,revision_id", "maps_node", "id,revision_id", "edge_from_scope_fk"),
    ("maps_edge", "to_node_id,revision_id", "maps_node", "id,revision_id", "edge_to_scope_fk"),
    (
        "maps_referencephoto",
        "node_id,revision_id",
        "maps_node",
        "id,revision_id",
        "reference_node_scope_fk",
    ),
    (
        "maps_scenerelationship",
        "reference_id,revision_id",
        "maps_referencephoto",
        "id,revision_id",
        "relationship_photo_scope_fk",
    ),
    (
        "maps_scenerelationship",
        "room_id,revision_id",
        "maps_room",
        "id,revision_id",
        "relationship_room_scope_fk",
    ),
    (
        "maps_scenerelationship",
        "node_id,revision_id",
        "maps_node",
        "id,revision_id",
        "relationship_node_scope_fk",
    ),
    (
        "maps_publication",
        "revision_id,target_id",
        "maps_revision",
        "id,target_id",
        "publication_target_scope_fk",
    ),
    (
        "maps_publication",
        "approval_id,revision_id",
        "maps_review",
        "id,revision_id",
        "publication_approval_scope_fk",
    ),
    (
        "maps_changeset",
        "result_revision_id,contribution_id",
        "maps_revision",
        "id,contribution_id",
        "change_result_scope_fk",
    ),
    (
        "maps_auditevent",
        "revision_id,target_id",
        "maps_revision",
        "id,target_id",
        "audit_revision_scope_fk",
    ),
    ("jobs_job", "revision_id,target_id", "maps_revision", "id,target_id", "job_target_scope_fk"),
    (
        "jobs_job",
        "session_id,revision_id",
        "navigation_navigationsession",
        "id,revision_id",
        "job_session_scope_fk",
    ),
    (
        "navigation_navigationsession",
        "publication_id,revision_id",
        "maps_publication",
        "id,revision_id",
        "session_publication_scope_fk",
    ),
    (
        "navigation_navigationsession",
        "destination_id,revision_id",
        "maps_node",
        "id,revision_id",
        "session_destination_scope_fk",
    ),
    (
        "navigation_navigationsession",
        "confirmed_result_id,id",
        "navigation_localizationresult",
        "id,session_id",
        "session_result_scope_fk",
    ),
    (
        "navigation_navigationsession",
        "confirmed_result_id,revision_id",
        "navigation_localizationresult",
        "id,revision_id",
        "session_result_revision_fk",
    ),
    (
        "navigation_capture",
        "session_id,revision_id",
        "navigation_navigationsession",
        "id,revision_id",
        "capture_session_scope_fk",
    ),
    (
        "navigation_capture",
        "job_id,session_id",
        "jobs_job",
        "id,session_id",
        "capture_job_session_fk",
    ),
    (
        "navigation_capture",
        "job_id,revision_id",
        "jobs_job",
        "id,revision_id",
        "capture_job_revision_fk",
    ),
    (
        "navigation_localizationresult",
        "capture_id,session_id",
        "navigation_capture",
        "id,session_id",
        "result_capture_session_fk",
    ),
    (
        "navigation_localizationresult",
        "capture_id,revision_id",
        "navigation_capture",
        "id,revision_id",
        "result_capture_revision_fk",
    ),
    (
        "navigation_localizationresult",
        "node_id,revision_id",
        "maps_node",
        "id,revision_id",
        "result_node_scope_fk",
    ),
    (
        "navigation_route",
        "session_id,revision_id",
        "navigation_navigationsession",
        "id,revision_id",
        "route_session_scope_fk",
    ),
    (
        "navigation_route",
        "localization_id,session_id",
        "navigation_localizationresult",
        "id,session_id",
        "route_result_session_fk",
    ),
    (
        "navigation_route",
        "localization_id,revision_id",
        "navigation_localizationresult",
        "id,revision_id",
        "route_result_revision_fk",
    ),
    (
        "navigation_route",
        "destination_id,revision_id",
        "maps_node",
        "id,revision_id",
        "route_destination_scope_fk",
    ),
]

SNAPSHOT_TABLES = [
    "maps_mapobject",
    "maps_room",
    "maps_node",
    "maps_edge",
    "maps_referencephoto",
    "maps_scenerelationship",
]
APPEND_ONLY_TABLES = [
    "maps_asset",
    "maps_review",
    "maps_changeset",
    "maps_auditevent",
    "navigation_capture",
    "navigation_localizationresult",
]

GUARDS = """
CREATE FUNCTION snapway_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% records are append-only', TG_TABLE_NAME USING ERRCODE = '23514';
END $$;

CREATE FUNCTION snapway_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP <> 'INSERT' AND OLD.frozen_at IS NOT NULL THEN
        RAISE EXCEPTION 'Frozen revisions are immutable' USING ERRCODE = '23514';
    END IF;
    IF TG_OP <> 'DELETE' THEN
        IF jsonb_typeof(NEW.geometry) <> 'object'
           OR jsonb_typeof(NEW.coordinate_frame) <> 'object' THEN
            RAISE EXCEPTION 'Geometry and coordinate frame must be JSON objects'
                USING ERRCODE = '23514';
        END IF;
        IF NEW.frozen_at IS NOT NULL AND NEW.content_hash !~ '^[0-9a-f]{64}$' THEN
            RAISE EXCEPTION 'Frozen revision requires a SHA-256 content digest'
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    RETURN OLD;
END $$;

CREATE FUNCTION snapway_snapshot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rid uuid; frozen timestamptz;
BEGIN
    -- Lock both old and new scopes when moving a row. A freeze waits for any
    -- in-flight child writes; subsequent writes see the frozen state.
    FOR rid IN
        SELECT DISTINCT value FROM unnest(ARRAY[
            CASE WHEN TG_OP <> 'INSERT' THEN OLD.revision_id END,
            CASE WHEN TG_OP <> 'DELETE' THEN NEW.revision_id END
        ]) AS value WHERE value IS NOT NULL ORDER BY value
    LOOP
        SELECT frozen_at INTO frozen FROM maps_revision WHERE id = rid FOR SHARE;
        IF frozen IS NOT NULL THEN
            RAISE EXCEPTION 'Frozen revision content is immutable' USING ERRCODE = '23514';
        END IF;
    END LOOP;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END $$;

CREATE FUNCTION snapway_asset_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE asset_target uuid; revision_target uuid; asset_kind text; expected_kind text;
BEGIN
    IF NEW.asset_id IS NULL THEN RETURN NEW; END IF;
    SELECT target_id, kind INTO asset_target, asset_kind FROM maps_asset WHERE id = NEW.asset_id;
    SELECT target_id INTO revision_target FROM maps_revision WHERE id = NEW.revision_id;
    expected_kind := TG_ARGV[0];
    IF TG_TABLE_NAME = 'maps_revisionartifact' THEN expected_kind := NEW.kind; END IF;
    IF asset_target IS DISTINCT FROM revision_target OR asset_kind IS DISTINCT FROM expected_kind THEN
        RAISE EXCEPTION 'Asset must match the revision target and expected kind'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;

CREATE FUNCTION snapway_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE frozen timestamptz;
BEGIN
    SELECT frozen_at INTO frozen FROM maps_revision WHERE id = NEW.revision_id FOR SHARE;
    IF frozen IS NULL THEN
        RAISE EXCEPTION 'Review must address frozen content' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;

CREATE FUNCTION snapway_artifact_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rid uuid;
BEGIN
    FOR rid IN
        SELECT DISTINCT value FROM unnest(ARRAY[
            CASE WHEN TG_OP <> 'INSERT' THEN OLD.revision_id END,
            CASE WHEN TG_OP <> 'DELETE' THEN NEW.revision_id END
        ]) AS value WHERE value IS NOT NULL ORDER BY value
    LOOP
        PERFORM id FROM maps_revision WHERE id = rid FOR UPDATE;
        IF EXISTS (SELECT 1 FROM maps_publication WHERE revision_id = rid) THEN
            RAISE EXCEPTION 'Published artifacts are immutable' USING ERRCODE = '23514';
        END IF;
    END LOOP;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END $$;

CREATE FUNCTION snapway_publication_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE candidate maps_revision; review_decision text; target_status text;
        contribution_row maps_contribution; latest maps_publication;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Publication history cannot be deleted' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' AND
       (to_jsonb(NEW) - ARRAY['is_current','invalidated_at','invalidation_reason'])
       IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['is_current','invalidated_at','invalidation_reason']) THEN
        RAISE EXCEPTION 'Publication content identity is immutable' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.invalidated_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'Invalidation is permanent' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'INSERT' OR (NEW.is_current AND NOT OLD.is_current) THEN
        -- Same lock order must be used by the future publication service.
        SELECT status INTO target_status FROM maps_maptarget WHERE id = NEW.target_id FOR UPDATE;
        SELECT * INTO candidate FROM maps_revision WHERE id = NEW.revision_id FOR UPDATE;
        SELECT decision INTO review_decision FROM maps_review WHERE id = NEW.approval_id;
        SELECT * INTO contribution_row FROM maps_contribution
            WHERE id = candidate.contribution_id FOR SHARE;
        IF target_status <> 'open' OR candidate.frozen_at IS NULL
           OR review_decision IS DISTINCT FROM 'approved'
           OR contribution_row.status NOT IN ('submitted', 'merged')
           OR contribution_row.head_revision_id IS DISTINCT FROM candidate.id THEN
            RAISE EXCEPTION 'Publication requires open target, frozen submitted content and approval'
                USING ERRCODE = '23514';
        END IF;
        IF NEW.approval_id IS DISTINCT FROM
           (SELECT id FROM maps_review WHERE revision_id = candidate.id
            ORDER BY created_at DESC, id DESC LIMIT 1) THEN
            RAISE EXCEPTION 'Publication requires the latest review of the exact content'
                USING ERRCODE = '23514';
        END IF;
        SELECT * INTO latest FROM maps_publication WHERE target_id = NEW.target_id
            ORDER BY sequence DESC LIMIT 1;
        IF TG_OP = 'INSERT' AND
           (NEW.sequence <> COALESCE(latest.sequence, 0) + 1
            OR contribution_row.base_revision_id IS DISTINCT FROM latest.revision_id) THEN
            RAISE EXCEPTION 'Publication base is stale or sequence is not the next revision'
                USING ERRCODE = '23514';
        END IF;
        IF TG_OP = 'UPDATE' AND NEW.sequence <> latest.sequence THEN
            RAISE EXCEPTION 'Historical publications cannot replace newer revisions'
                USING ERRCODE = '23514';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM maps_revisionartifact
                       WHERE revision_id = candidate.id AND kind = 'svg'
                         AND state = 'ready' AND required)
           OR EXISTS (SELECT 1 FROM maps_revisionartifact
                      WHERE revision_id = candidate.id AND required
                        AND (state <> 'ready' OR input_content_hash <> candidate.content_hash)) THEN
            RAISE EXCEPTION 'Required artifacts must be ready for the exact revision content'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END $$;

CREATE FUNCTION snapway_changeset_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (SELECT target_id FROM maps_revision WHERE id = NEW.base_revision_id)
       IS DISTINCT FROM
       (SELECT target_id FROM maps_contribution WHERE id = NEW.contribution_id) THEN
        RAISE EXCEPTION 'Change base must belong to the same target' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
"""

# Fixed names permit exact reversals without discovering/dropping unrelated objects.
TRIGGERS = [
    ("maps_revision", "revision_guard", "INSERT OR UPDATE OR DELETE", "snapway_revision_guard()"),
    (
        "maps_referencephoto",
        "reference_asset_guard",
        "INSERT OR UPDATE",
        "snapway_asset_scope_guard('photo')",
    ),
    (
        "maps_revisionartifact",
        "artifact_asset_guard",
        "INSERT OR UPDATE",
        "snapway_asset_scope_guard('')",
    ),
    (
        "navigation_capture",
        "capture_asset_guard",
        "INSERT OR UPDATE",
        "snapway_asset_scope_guard('capture')",
    ),
    ("maps_review", "review_frozen_guard", "INSERT", "snapway_review_guard()"),
    (
        "maps_revisionartifact",
        "artifact_publication_guard",
        "INSERT OR UPDATE OR DELETE",
        "snapway_artifact_guard()",
    ),
    (
        "maps_publication",
        "publication_guard",
        "INSERT OR UPDATE OR DELETE",
        "snapway_publication_guard()",
    ),
    ("maps_changeset", "change_base_guard", "INSERT", "snapway_changeset_guard()"),
]


def install(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
    for child, columns, parent, keys, name in SCOPE_LINKS:
        schema_editor.execute(
            f'ALTER TABLE "{child}" ADD CONSTRAINT "{name}" '
            f'FOREIGN KEY ({columns}) REFERENCES "{parent}" ({keys}) '
            "DEFERRABLE INITIALLY IMMEDIATE"
        )
    schema_editor.execute(GUARDS, params=None)
    for table in SNAPSHOT_TABLES:
        schema_editor.execute(
            f'CREATE TRIGGER snapshot_guard BEFORE INSERT OR UPDATE OR DELETE ON "{table}" '
            "FOR EACH ROW EXECUTE FUNCTION snapway_snapshot_guard()"
        )
    for table in APPEND_ONLY_TABLES:
        schema_editor.execute(
            f'CREATE TRIGGER append_only_guard BEFORE UPDATE OR DELETE ON "{table}" '
            "FOR EACH ROW EXECUTE FUNCTION snapway_append_only()"
        )
    for table, name, events, function in TRIGGERS:
        schema_editor.execute(
            f'CREATE TRIGGER "{name}" BEFORE {events} ON "{table}" '
            f"FOR EACH ROW EXECUTE FUNCTION {function}"
        )


def uninstall(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
    for table, name, _, _ in TRIGGERS:
        schema_editor.execute(f'DROP TRIGGER "{name}" ON "{table}"')
    for table in APPEND_ONLY_TABLES:
        schema_editor.execute(f'DROP TRIGGER append_only_guard ON "{table}"')
    for table in SNAPSHOT_TABLES:
        schema_editor.execute(f'DROP TRIGGER snapshot_guard ON "{table}"')
    for function in [
        "snapway_changeset_guard",
        "snapway_publication_guard",
        "snapway_artifact_guard",
        "snapway_review_guard",
        "snapway_asset_scope_guard",
        "snapway_snapshot_guard",
        "snapway_revision_guard",
        "snapway_append_only",
    ]:
        schema_editor.execute(f"DROP FUNCTION {function}()")
    for child, _, _, _, name in reversed(SCOPE_LINKS):
        schema_editor.execute(f'ALTER TABLE "{child}" DROP CONSTRAINT "{name}"')


class Migration(migrations.Migration):
    dependencies = [
        ("maps", "0001_initial"),
        ("jobs", "0002_initial"),
        ("navigation", "0001_initial"),
    ]
    operations = [migrations.RunPython(install, uninstall)]
