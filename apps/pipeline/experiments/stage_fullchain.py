"""SQLite staging for real unreviewed extraction; no shared database writes."""

import json
import sqlite3
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "local/test-results/gpt-fullchain-2026-10-17"


def main():
    inventory = json.loads((OUT / "inventory/result.json").read_text(encoding="utf-8"))
    provenance = json.loads((OUT / "input-provenance.json").read_text(encoding="utf-8"))
    run = "IA1-GPT-2026-10-17"
    path = OUT / "experiment.sqlite3"
    with sqlite3.connect(path) as db:
        db.execute("PRAGMA foreign_keys=ON")
        db.executescript("""
        CREATE TABLE IF NOT EXISTS experiments(
            id TEXT PRIMARY KEY, source_sha256 TEXT NOT NULL, provenance_json TEXT NOT NULL,
            shared_import_state TEXT NOT NULL DEFAULT 'pending');
        CREATE TABLE IF NOT EXISTS observations(
            id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL REFERENCES experiments(id),
            kind TEXT NOT NULL, name TEXT NOT NULL, raw_text TEXT NOT NULL, capacity INTEGER,
            frame_id TEXT NOT NULL, label_position_json TEXT NOT NULL,
            observation_state TEXT NOT NULL, raw_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS room_candidates(
            id TEXT PRIMARY KEY, observation_id TEXT NOT NULL UNIQUE REFERENCES observations(id),
            stable_id TEXT NOT NULL UNIQUE, number TEXT NOT NULL, name TEXT NOT NULL,
            purpose TEXT NOT NULL, attributes_json TEXT NOT NULL, provenance_json TEXT NOT NULL,
            target_revision_id TEXT, import_state TEXT NOT NULL DEFAULT 'unreviewed');
        CREATE TABLE IF NOT EXISTS vector_regions(
            id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL REFERENCES experiments(id),
            stage_name TEXT NOT NULL, local_id TEXT NOT NULL, role TEXT NOT NULL,
            polygon_json TEXT NOT NULL, frame_id TEXT NOT NULL, schema_valid INTEGER NOT NULL,
            basic_polygon_valid INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS observation_region_links(
            observation_id TEXT NOT NULL REFERENCES observations(id),
            vector_region_id TEXT NOT NULL REFERENCES vector_regions(id),
            review_state TEXT NOT NULL DEFAULT 'unreviewed',
            PRIMARY KEY(observation_id,vector_region_id));
        CREATE TABLE IF NOT EXISTS model_calls(
            id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL REFERENCES experiments(id),
            metadata_json TEXT NOT NULL);
        """)
        if "geometry_valid" in [r[1] for r in db.execute("PRAGMA table_info(vector_regions)")]:
            db.execute(
                "ALTER TABLE vector_regions RENAME COLUMN geometry_valid TO basic_polygon_valid"
            )
        if db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='room_region_links'"
        ).fetchone():
            db.execute(
                "INSERT OR IGNORE INTO observation_region_links SELECT * FROM room_region_links"
            )
            # Local prototype rename: all old associations have been retained above.
            db.execute("DROP TABLE room_region_links")
        db.execute(
            "INSERT OR REPLACE INTO experiments(id,source_sha256,provenance_json) VALUES(?,?,?)",
            (run, provenance["sourceSha256"], json.dumps(provenance)),
        )
        for o in inventory["observations"]:
            oid = run + ":" + o["id"]
            db.execute(
                "INSERT OR REPLACE INTO observations VALUES(?,?,?,?,?,?,?,?,?,?)",
                (
                    oid,
                    run,
                    o["kind"],
                    o["name"],
                    o["raw_text"],
                    o["capacity"],
                    inventory["frame_id"],
                    json.dumps(o["label_position"]),
                    o["observation"],
                    json.dumps(o),
                ),
            )
            if o["kind"] == "room":
                stable = str(
                    uuid.uuid5(uuid.NAMESPACE_URL, provenance["sourceSha256"] + ":" + o["id"])
                )
                attrs = {
                    "capacity": o["capacity"],
                    "capacity_source": "read from original photo",
                    "review_state": "unreviewed",
                }
                evidence = {
                    "source_sha256": provenance["sourceSha256"],
                    "frame_id": inventory["frame_id"],
                    "label_position": o["label_position"],
                    "raw_text": o["raw_text"],
                    "observation": o["observation"],
                    "model": "gpt-6.1-sol",
                }
                db.execute(
                    "INSERT OR REPLACE INTO room_candidates("
                    "id,observation_id,stable_id,number,name,purpose,"
                    "attributes_json,provenance_json) "
                    "VALUES(?,?,?,?,?,?,?,?)",
                    (oid, oid, stable, "", o["name"], "", json.dumps(attrs), json.dumps(evidence)),
                )
        for folder in sorted(OUT.glob("*-trace*")):
            if not (folder / "result.json").exists():
                continue
            trace = json.loads((folder / "result.json").read_text(encoding="utf-8"))
            validation = (
                json.loads((folder / "basic-validation.json").read_text(encoding="utf-8"))
                if (folder / "basic-validation.json").exists()
                else {}
            )
            for s in trace["spaces"]:
                rid = run + ":" + folder.name + ":" + s["local_id"]
                db.execute(
                    "INSERT OR REPLACE INTO vector_regions VALUES(?,?,?,?,?,?,?,?,?)",
                    (
                        rid,
                        run,
                        folder.name,
                        s["local_id"],
                        s["role"],
                        json.dumps(s["polygon"]),
                        trace["frame_id"],
                        int(validation.get("schemaValid", False)),
                        int(validation.get("basicPolygonValid", False)),
                    ),
                )
                for ref in s["label_refs"]:
                    if any(o["id"] == ref for o in inventory["observations"]):
                        db.execute(
                            "INSERT OR IGNORE INTO observation_region_links("
                            "observation_id,vector_region_id) VALUES(?,?)",
                            (run + ":" + ref, rid),
                        )
        if (OUT / "ledger.json").exists():
            for i, call in enumerate(json.loads((OUT / "ledger.json").read_text(encoding="utf-8"))):
                db.execute(
                    "INSERT OR REPLACE INTO model_calls VALUES(?,?,?)",
                    (run + ":call:" + str(i), run, json.dumps(call)),
                )
        if (OUT / "image-ledger.json").exists():
            call = json.loads((OUT / "image-ledger.json").read_text(encoding="utf-8"))
            db.execute(
                "INSERT OR REPLACE INTO model_calls VALUES(?,?,?)",
                (run + ":image", run, json.dumps(call)),
            )
        summary = {
            table: db.execute("SELECT COUNT(*) FROM " + table).fetchone()[0]
            for table in [
                "experiments",
                "observations",
                "room_candidates",
                "vector_regions",
                "observation_region_links",
                "model_calls",
            ]
        }
        summary["room_candidate_count"] = summary["room_candidates"]
        summary["room_candidates"] = [
            {"name": n, "attributes": json.loads(a)}
            for n, a in db.execute("SELECT name,attributes_json FROM room_candidates ORDER BY name")
        ]
        summary["shared_database_written"] = False
        summary["mapping"] = {
            "room_candidates.name": "maps.Room.name",
            "room_candidates.number": "maps.Room.number",
            "room_candidates.purpose": "maps.Room.purpose",
            "room_candidates.attributes_json": "maps.Room.attributes",
            "room_candidates.provenance_json": "maps.Room.provenance",
            "room_candidates.stable_id": "maps.MapObject.stable_id",
            "vector_regions.polygon_json": (
                "maps.Revision.geometry (through reviewed domain import)"
            ),
            "target_revision_id": (
                "unresolved; requires existing authorized target/contribution/revision"
            ),
        }
        summary["staging_reason"] = (
            "Existing Room schema supports metadata; shared DB read-only probe failed "
            "(OperationalError), and authorized target/revision/domain import is not established. "
            "No shared schema migration or fake actor created."
        )
    (OUT / "staging-summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
