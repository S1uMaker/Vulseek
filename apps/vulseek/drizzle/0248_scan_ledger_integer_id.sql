-- Drizzle runs this migration in a transaction. Lock writes while building
-- the ID map so new rows and references cannot escape the conversion.
LOCK TABLE "scan_ledger_entries" IN ACCESS EXCLUSIVE MODE;

CREATE TEMP TABLE ledger_id_migration_map ON COMMIT DROP AS
SELECT "id" AS old_id,
	(row_number() OVER (ORDER BY "createdAt", "id"))::integer AS new_id
FROM "scan_ledger_entries";

CREATE UNIQUE INDEX ON ledger_id_migration_map (old_id);

CREATE FUNCTION pg_temp.ledger_entry_integer_id(old_id text)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
	mapped_id integer;
BEGIN
	SELECT m.new_id INTO mapped_id
	FROM pg_temp.ledger_id_migration_map m
	WHERE m.old_id = $1;
	IF mapped_id IS NULL THEN
		RAISE EXCEPTION 'Ledger ID migration: unresolved entry reference %', old_id;
	END IF;
	RETURN mapped_id;
END;
$$;

-- Only structured entry pointers are rewritten. Evidence/gap/link IDs and
-- free-form statements, reasons and historical feedback remain unchanged.
-- Recursion also covers change-history from/to values and evidenceRefs.
CREATE FUNCTION pg_temp.ledger_integer_refs(value jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
	result jsonb;
	member record;
BEGIN
	IF jsonb_typeof(value) = 'object' THEN
		result := '{}'::jsonb;
		FOR member IN SELECT * FROM jsonb_each(value) LOOP
			IF member.key IN ('entryId', 'targetId', 'scopeHypothesisId')
				AND jsonb_typeof(member.value) IN ('string', 'number') THEN
				result := result || jsonb_build_object(
					member.key,
					pg_temp.ledger_entry_integer_id(member.value #>> '{}')
				);
			ELSE
				result := result || jsonb_build_object(
					member.key, pg_temp.ledger_integer_refs(member.value)
				);
			END IF;
		END LOOP;
		RETURN result;
	ELSIF jsonb_typeof(value) = 'array' THEN
		SELECT COALESCE(
			jsonb_agg(pg_temp.ledger_integer_refs(element) ORDER BY ordinal),
			'[]'::jsonb
		) INTO result
		FROM jsonb_array_elements(value) WITH ORDINALITY AS items(element, ordinal);
		RETURN result;
	END IF;
	RETURN value;
END;
$$;

UPDATE "scan_ledger_entries"
SET "assessment" = pg_temp.ledger_integer_refs("assessment"),
	"evidence" = pg_temp.ledger_integer_refs("evidence"),
	"gaps" = pg_temp.ledger_integer_refs("gaps"),
	"links" = pg_temp.ledger_integer_refs("links"),
	"changes" = pg_temp.ledger_integer_refs("changes");

ALTER TABLE "scan_ledger_entries"
	ALTER COLUMN "id" DROP DEFAULT,
	ALTER COLUMN "id" TYPE integer USING pg_temp.ledger_entry_integer_id("id");

ALTER TABLE "scan_ledger_entries"
	ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY;

SELECT setval(
	pg_get_serial_sequence('scan_ledger_entries', 'id'),
	COALESCE(max("id"), 1),
	count(*) > 0
) FROM "scan_ledger_entries";

DROP FUNCTION pg_temp.ledger_integer_refs(jsonb);
DROP FUNCTION pg_temp.ledger_entry_integer_id(text);
