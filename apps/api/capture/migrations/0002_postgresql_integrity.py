"""PostgreSQL-only scope keys and asset-kind guard for capture photos.

Mirrors maps/0002: a photo's session, point and three image assets must share
its target, and every capture image asset must be of kind "photo". SQLite keeps
its onboarding role and skips this migration.
"""

from django.db import migrations

SCOPE_LINKS = [
    (
        "capture_capturephoto",
        "session_id,target_id",
        "capture_capturesession",
        "id,target_id",
        "capture_photo_session_scope_fk",
    ),
    (
        "capture_capturephoto",
        "point_id,session_id",
        "capture_capturepoint",
        "id,session_id",
        "capture_photo_point_scope_fk",
    ),
    (
        "capture_capturephoto",
        "original_asset_id,target_id",
        "maps_asset",
        "id,target_id",
        "capture_photo_original_scope_fk",
    ),
    (
        "capture_capturephoto",
        "display_asset_id,target_id",
        "maps_asset",
        "id,target_id",
        "capture_photo_display_scope_fk",
    ),
    (
        "capture_capturephoto",
        "thumbnail_asset_id,target_id",
        "maps_asset",
        "id,target_id",
        "capture_photo_thumbnail_scope_fk",
    ),
]

GUARD = """
CREATE FUNCTION snapway_capture_photo_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM maps_asset
        WHERE id IN (NEW.original_asset_id, NEW.display_asset_id, NEW.thumbnail_asset_id)
          AND kind <> 'photo'
    ) THEN
        RAISE EXCEPTION 'Capture photo assets must be of kind photo' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
"""


def install(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
    for child, columns, parent, keys, name in SCOPE_LINKS:
        schema_editor.execute(
            f'ALTER TABLE "{child}" ADD CONSTRAINT "{name}" '
            f'FOREIGN KEY ({columns}) REFERENCES "{parent}" ({keys}) '
            "DEFERRABLE INITIALLY IMMEDIATE"
        )
    schema_editor.execute(GUARD, params=None)
    schema_editor.execute(
        'CREATE TRIGGER capture_photo_asset_guard BEFORE INSERT OR UPDATE ON "capture_capturephoto" '
        "FOR EACH ROW EXECUTE FUNCTION snapway_capture_photo_guard()"
    )


def uninstall(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
    schema_editor.execute('DROP TRIGGER capture_photo_asset_guard ON "capture_capturephoto"')
    schema_editor.execute("DROP FUNCTION snapway_capture_photo_guard()")
    for child, _, _, _, name in reversed(SCOPE_LINKS):
        schema_editor.execute(f'ALTER TABLE "{child}" DROP CONSTRAINT "{name}"')


class Migration(migrations.Migration):
    dependencies = [("capture", "0001_initial"), ("maps", "0002_postgresql_integrity")]
    operations = [migrations.RunPython(install, uninstall)]
