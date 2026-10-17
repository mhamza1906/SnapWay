# Shared contracts

[postgresql-schema.sql](postgresql-schema.sql) is a generated schema-only snapshot
from PostgreSQL 17.11, including Django framework tables, constraints, functions
and triggers. It contains no records, credentials, ownership grants or migration
history rows. Use Django migrations to initialize or upgrade an application
database; this SQL is a review/reference artifact, not a second migration source.
It requires compatible PostgreSQL/psql tooling if inspected through a scratch restore.

Regenerate it from a freshly migrated, disposable PostgreSQL database:

```sh
pg_dump --dbname="$TEST_DATABASE_URL" --schema-only --no-owner --no-privileges --no-comments --file=contracts/postgresql-schema.sql
```

The [database feature record](../docs/database-schema.md) describes entities,
integrity boundaries and verification. Update this snapshot when migrations
change. Future agreed API/geometry payload schemas and sanitized fixtures belong
here; their exact contracts and MCP mutation signatures remain unfrozen. The
development health responses are documented in [the development guide](../docs/development.md).
