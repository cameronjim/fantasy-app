"""
Migration state checker.

This project has no migration runner: every file in db/migrations/ is applied by
hand in the Neon SQL editor, against two databases (prod and the dev branch).
That makes "has 013 been applied to this one?" a real question with no answer,
and the usual way it gets answered is a "relation does not exist" error in
production.

This script answers it instead. It hashes every migration on disk and compares
against the schema_migrations table (added by migration 013), then reports:

    applied            - recorded, and the file is unchanged since
    not applied        - on disk, nothing recorded
    checksum mismatch  - recorded, but the file has been edited since
    unknown to disk    - recorded, but no such file (a deleted migration)

Usage:
    cd scraper/
    python check_migrations.py            # prod (DATABASE_URL)
    python check_migrations.py --dev      # dev branch (DATABASE_URL_DEV)
    python check_migrations.py --record 013_truth_layer.sql

Read-only unless --record is passed. --record writes a schema_migrations row for
a migration you have just applied by hand; it does NOT execute any SQL from the
migration file, so it can never be mistaken for a migration runner.

Exit codes: 0 = everything on disk is applied and unchanged, 1 = otherwise.
"""

import argparse
import hashlib
import logging
import os
import sys

import psycopg2

# so `python scraper/check_migrations.py` works from the repo root, not only
# from inside scraper/
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# resolve_database_url owns the DATABASE_URL / DATABASE_URL_DEV rules and the
# actionable error message when one is missing. Reused rather than duplicated so
# --dev cannot come to mean two different things in two files.
from run_scraper import TARGET_DEV, TARGET_PROD, resolve_database_url  # noqa: E402

logger = logging.getLogger(__name__)

MIGRATIONS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "db", "migrations"
)


def migration_files(directory: str = MIGRATIONS_DIR) -> list[str]:
    """Migration filenames in numeric order.

    Sorted lexicographically, which is numeric order given the zero-padded
    three-digit prefix the convention already uses.
    """
    if not os.path.isdir(directory):
        return []
    return sorted(f for f in os.listdir(directory) if f.endswith(".sql"))


def file_checksum(path: str) -> str:
    """sha256 of a file's bytes.

    Bytes, not text: a checksum that changed when someone's editor rewrote the
    line endings would cry wolf on every checkout.
    """
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _recorded_migrations(conn: psycopg2.extensions.connection) -> dict[str, str] | None:
    """filename -> checksum from schema_migrations, or None if the table is absent.

    None is a meaningful answer, not an error: on a database where migration 013
    has not been applied yet the table genuinely does not exist, and the whole
    point of this script is to survive that state and say so.
    """
    cur = conn.cursor()
    try:
        cur.execute("SELECT to_regclass('schema_migrations')")
        row = cur.fetchone()
        if not row or row[0] is None:
            return None
        cur.execute("SELECT filename, checksum FROM schema_migrations")
        return {str(name): str(checksum) for name, checksum in cur.fetchall()}
    finally:
        cur.close()


def _record(conn: psycopg2.extensions.connection, filename: str, checksum: str) -> None:
    cur = conn.cursor()
    try:
        cur.execute(
            """
            INSERT INTO schema_migrations (filename, checksum)
            VALUES (%s, %s)
            ON CONFLICT (filename) DO UPDATE SET
                checksum = EXCLUDED.checksum, applied_at = NOW()
            """,
            (filename, checksum),
        )
    finally:
        cur.close()


def classify(
    on_disk: dict[str, str], recorded: dict[str, str]
) -> dict[str, list[str]]:
    """Split every known migration into applied / unapplied / mismatched / orphaned.

    Pure over two dicts so the reporting logic is testable without a database.
    """
    applied: list[str] = []
    unapplied: list[str] = []
    mismatched: list[str] = []

    for filename, checksum in sorted(on_disk.items()):
        if filename not in recorded:
            unapplied.append(filename)
        elif recorded[filename] != checksum:
            mismatched.append(filename)
        else:
            applied.append(filename)

    orphaned = sorted(set(recorded) - set(on_disk))
    return {
        "applied": applied,
        "unapplied": unapplied,
        "mismatched": mismatched,
        "orphaned": orphaned,
    }


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="report migration state")
    # mirrors run_scraper's flags exactly, including prod-by-default, so the two
    # scripts can never be pointed at different databases by the same command
    target = parser.add_mutually_exclusive_group()
    target.add_argument(
        "--dev",
        dest="target",
        action="store_const",
        const=TARGET_DEV,
        help="check the dev Neon branch (uses DATABASE_URL_DEV)",
    )
    target.add_argument(
        "--prod",
        dest="target",
        action="store_const",
        const=TARGET_PROD,
        help="check the prod database (uses DATABASE_URL, the default)",
    )
    parser.set_defaults(target=TARGET_PROD)
    parser.add_argument(
        "--record",
        dest="record",
        metavar="FILENAME",
        help=(
            "record a migration you have already applied by hand, e.g. "
            "013_truth_layer.sql. Writes a schema_migrations row and nothing else"
        ),
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)

    files = migration_files()
    if not files:
        logger.error("no migrations found in %s", MIGRATIONS_DIR)
        return 1

    on_disk = {
        name: file_checksum(os.path.join(MIGRATIONS_DIR, name)) for name in files
    }

    conn = psycopg2.connect(resolve_database_url(args.target))
    conn.autocommit = True
    try:
        if args.record:
            if args.record not in on_disk:
                logger.error("%s is not in %s", args.record, MIGRATIONS_DIR)
                return 1
            _record(conn, args.record, on_disk[args.record])
            logger.info("recorded %s as applied", args.record)
            return 0

        recorded = _recorded_migrations(conn)
    finally:
        conn.close()

    if recorded is None:
        logger.warning(
            "schema_migrations does not exist on this database, so nothing is "
            "recorded. Apply db/migrations/013_truth_layer.sql first, then "
            "backfill the record with --record for each migration already applied."
        )
        logger.info("%d migration(s) on disk:", len(files))
        for name in files:
            logger.info("    unrecorded   %s", name)
        return 1

    if not recorded:
        logger.warning(
            "schema_migrations exists but is empty. Either nothing has been "
            "recorded yet or this is a fresh database — the table cannot tell "
            "the difference, so check before assuming."
        )

    result = classify(on_disk, recorded)

    for name in result["applied"]:
        logger.info("    applied      %s", name)
    for name in result["unapplied"]:
        logger.warning("    NOT APPLIED  %s", name)
    for name in result["mismatched"]:
        logger.error("    CHECKSUM     %s (file edited since it was applied)", name)
    for name in result["orphaned"]:
        logger.error("    NO SUCH FILE %s (recorded, but not on disk)", name)

    logger.info(
        "%d applied, %d not applied, %d checksum mismatch, %d recorded but missing",
        len(result["applied"]), len(result["unapplied"]),
        len(result["mismatched"]), len(result["orphaned"]),
    )

    clean = not (result["unapplied"] or result["mismatched"] or result["orphaned"])
    return 0 if clean else 1


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    sys.exit(main())
