"""Last approved wins; permit scoped deletion only after target archival."""

from importlib import import_module

from django.db import migrations


def install(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
    original = import_module("maps.migrations.0002_postgresql_integrity").GUARDS
    sql = original.replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION")
    sql = sql.replace(
        "NEW.sequence <> COALESCE(latest.sequence, 0) + 1\n"
        "            OR contribution_row.base_revision_id IS DISTINCT FROM latest.revision_id",
        "NEW.sequence <> COALESCE(latest.sequence, 0) + 1",
    )
    # Keep ordinary immutable guards intact. DELETE may only bypass a guard in
    # the exact archived map explicitly selected by the authenticated service.
    for function in [
        "append_only",
        "revision_guard",
        "snapshot_guard",
        "artifact_guard",
        "publication_guard",
    ]:
        start = sql.index(f"CREATE OR REPLACE FUNCTION snapway_{function}()")
        begin = sql.index("BEGIN", start) + len("BEGIN")
        sql = (
            sql[:begin]
            + "\n    IF TG_OP = 'DELETE' AND snapway_archived_purge(to_jsonb(OLD)) THEN RETURN OLD; END IF;"
            + sql[begin:]
        )
    schema_editor.execute("""
        CREATE FUNCTION snapway_archived_purge(row_data jsonb) RETURNS boolean LANGUAGE plpgsql AS $$
        DECLARE tid uuid; scope text;
        BEGIN
          scope := current_setting('snapway.purge_target', true);
          IF scope IS NULL OR scope = '' THEN RETURN false; END IF;
          tid := NULLIF(row_data->>'target_id', '')::uuid;
          IF tid IS NULL AND row_data ? 'revision_id' THEN
            SELECT target_id INTO tid FROM maps_revision WHERE id = (row_data->>'revision_id')::uuid;
          END IF;
          IF tid IS NULL AND row_data ? 'contribution_id' THEN
            SELECT target_id INTO tid FROM maps_contribution WHERE id = (row_data->>'contribution_id')::uuid;
          END IF;
          RETURN tid::text = scope AND EXISTS (
            SELECT 1 FROM maps_maptarget WHERE id = tid AND status = 'archived');
        END $$;
    """)
    schema_editor.execute(sql, params=None)


def uninstall(apps, schema_editor):
    if schema_editor.connection.vendor == "postgresql":
        sql = import_module("maps.migrations.0002_postgresql_integrity").GUARDS
        schema_editor.execute(
            sql.replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION"), params=None
        )
        schema_editor.execute("DROP FUNCTION snapway_archived_purge(jsonb)")


class Migration(migrations.Migration):
    dependencies = [("maps", "0004_building_google_place_id_contribution_updated_at_and_more")]
    operations = [migrations.RunPython(install, uninstall)]
