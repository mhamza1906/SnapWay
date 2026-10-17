--
-- PostgreSQL database dump
--

\restrict oNy2IkB2MCyJqnZ6vPb8aaMX6U3YFDG5AfPH3R6biNh2xWIX4Yg89fC717QuDpC

-- Dumped from database version 17.11
-- Dumped by pg_dump version 17.11

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: snapway_append_only(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.snapway_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION '% records are append-only', TG_TABLE_NAME USING ERRCODE = '23514';
END $$;


--
-- Name: snapway_artifact_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.snapway_artifact_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: snapway_asset_scope_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.snapway_asset_scope_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: snapway_changeset_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.snapway_changeset_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF (SELECT target_id FROM maps_revision WHERE id = NEW.base_revision_id)
       IS DISTINCT FROM
       (SELECT target_id FROM maps_contribution WHERE id = NEW.contribution_id) THEN
        RAISE EXCEPTION 'Change base must belong to the same target' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;


--
-- Name: snapway_publication_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.snapway_publication_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: snapway_review_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.snapway_review_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE frozen timestamptz;
BEGIN
    SELECT frozen_at INTO frozen FROM maps_revision WHERE id = NEW.revision_id FOR SHARE;
    IF frozen IS NULL THEN
        RAISE EXCEPTION 'Review must address frozen content' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;


--
-- Name: snapway_revision_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.snapway_revision_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
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
END $_$;


--
-- Name: snapway_snapshot_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.snapway_snapshot_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: accounts_user; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.accounts_user (
    id bigint NOT NULL,
    password character varying(128) NOT NULL,
    last_login timestamp with time zone,
    is_superuser boolean NOT NULL,
    username character varying(150) NOT NULL,
    first_name character varying(150) NOT NULL,
    last_name character varying(150) NOT NULL,
    email character varying(254) NOT NULL,
    is_staff boolean NOT NULL,
    is_active boolean NOT NULL,
    date_joined timestamp with time zone NOT NULL
);


--
-- Name: accounts_user_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.accounts_user_groups (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    group_id integer NOT NULL
);


--
-- Name: accounts_user_groups_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.accounts_user_groups ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.accounts_user_groups_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: accounts_user_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.accounts_user ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.accounts_user_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: accounts_user_user_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.accounts_user_user_permissions (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    permission_id integer NOT NULL
);


--
-- Name: accounts_user_user_permissions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.accounts_user_user_permissions ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.accounts_user_user_permissions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: auth_group; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_group (
    id integer NOT NULL,
    name character varying(150) NOT NULL
);


--
-- Name: auth_group_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.auth_group ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.auth_group_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: auth_group_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_group_permissions (
    id bigint NOT NULL,
    group_id integer NOT NULL,
    permission_id integer NOT NULL
);


--
-- Name: auth_group_permissions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.auth_group_permissions ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.auth_group_permissions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: auth_permission; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_permission (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    content_type_id integer NOT NULL,
    codename character varying(100) NOT NULL
);


--
-- Name: auth_permission_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.auth_permission ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.auth_permission_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: django_admin_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.django_admin_log (
    id integer NOT NULL,
    action_time timestamp with time zone NOT NULL,
    object_id text,
    object_repr character varying(200) NOT NULL,
    action_flag smallint NOT NULL,
    change_message text NOT NULL,
    content_type_id integer,
    user_id bigint NOT NULL,
    CONSTRAINT django_admin_log_action_flag_check CHECK ((action_flag >= 0))
);


--
-- Name: django_admin_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.django_admin_log ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.django_admin_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: django_content_type; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.django_content_type (
    id integer NOT NULL,
    app_label character varying(100) NOT NULL,
    model character varying(100) NOT NULL
);


--
-- Name: django_content_type_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.django_content_type ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.django_content_type_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: django_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.django_migrations (
    id bigint NOT NULL,
    app character varying(255) NOT NULL,
    name character varying(255) NOT NULL,
    applied timestamp with time zone NOT NULL
);


--
-- Name: django_migrations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.django_migrations ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.django_migrations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: django_session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.django_session (
    session_key character varying(40) NOT NULL,
    session_data text NOT NULL,
    expire_date timestamp with time zone NOT NULL
);


--
-- Name: jobs_job; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jobs_job (
    id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    operation character varying(80) NOT NULL,
    queue character varying(12) NOT NULL,
    idempotency_scope character varying(200) NOT NULL,
    idempotency_key character varying(100) NOT NULL,
    state character varying(12) NOT NULL,
    input_content_hash character varying(64) NOT NULL,
    input_payload jsonb NOT NULL,
    result_payload jsonb NOT NULL,
    error_code character varying(80) NOT NULL,
    deadline_at timestamp with time zone NOT NULL,
    next_attempt_at timestamp with time zone NOT NULL,
    dispatched_at timestamp with time zone,
    lease_token uuid,
    lease_expires_at timestamp with time zone,
    max_attempts smallint NOT NULL,
    finished_at timestamp with time zone,
    requested_by_id bigint,
    revision_id uuid,
    session_id uuid,
    target_id uuid NOT NULL,
    CONSTRAINT job_attempt_limit_ck CHECK ((max_attempts > 0)),
    CONSTRAINT job_lease_pair_ck CHECK ((((lease_expires_at IS NULL) AND (lease_token IS NULL)) OR ((lease_expires_at IS NOT NULL) AND (lease_token IS NOT NULL)))),
    CONSTRAINT job_principal_ck CHECK (((requested_by_id IS NOT NULL) OR (session_id IS NOT NULL))),
    CONSTRAINT job_queue_ck CHECK (((queue)::text = ANY ((ARRAY['authoring'::character varying, 'localization'::character varying])::text[]))),
    CONSTRAINT job_queue_principal_ck CHECK (((((queue)::text = 'authoring'::text) AND (requested_by_id IS NOT NULL) AND (session_id IS NULL)) OR (((queue)::text = 'localization'::text) AND (revision_id IS NOT NULL) AND (session_id IS NOT NULL)))),
    CONSTRAINT job_running_lease_ck CHECK (((NOT ((state)::text = 'running'::text)) OR ((lease_expires_at IS NOT NULL) AND (lease_token IS NOT NULL)))),
    CONSTRAINT job_state_ck CHECK (((state)::text = ANY ((ARRAY['pending'::character varying, 'queued'::character varying, 'running'::character varying, 'succeeded'::character varying, 'failed'::character varying, 'cancelled'::character varying, 'expired'::character varying])::text[]))),
    CONSTRAINT job_terminal_time_ck CHECK ((((finished_at IS NULL) AND ((state)::text = ANY ((ARRAY['pending'::character varying, 'queued'::character varying, 'running'::character varying])::text[]))) OR ((finished_at IS NOT NULL) AND ((state)::text = ANY ((ARRAY['succeeded'::character varying, 'failed'::character varying, 'cancelled'::character varying, 'expired'::character varying])::text[]))))),
    CONSTRAINT jobs_job_max_attempts_check CHECK ((max_attempts >= 0))
);


--
-- Name: jobs_jobattempt; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jobs_jobattempt (
    id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    number smallint NOT NULL,
    lease_token uuid NOT NULL,
    started_at timestamp with time zone NOT NULL,
    finished_at timestamp with time zone,
    provider character varying(80) NOT NULL,
    model character varying(100) NOT NULL,
    prompt_version character varying(100) NOT NULL,
    provider_request_id character varying(200) NOT NULL,
    outcome character varying(80) NOT NULL,
    usage jsonb NOT NULL,
    error_code character varying(80) NOT NULL,
    job_id uuid NOT NULL,
    CONSTRAINT attempt_number_ck CHECK ((number > 0)),
    CONSTRAINT attempt_time_ck CHECK (((finished_at IS NULL) OR (finished_at >= started_at))),
    CONSTRAINT jobs_jobattempt_number_check CHECK ((number >= 0))
);


--
-- Name: maps_asset; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.maps_asset (
    id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    kind character varying(16) NOT NULL,
    storage_key character varying(500) NOT NULL,
    content_type character varying(100) NOT NULL,
    sha256 character varying(64) NOT NULL,
    byte_size bigint NOT NULL,
    width integer,
    height integer,
    provenance jsonb NOT NULL,
    source_asset_id uuid,
    uploaded_by_id bigint,
    target_id uuid NOT NULL,
    CONSTRAINT asset_dimensions_ck CHECK ((((height IS NULL) AND (width IS NULL)) OR ((height > 0) AND (height IS NOT NULL) AND (width > 0) AND (width IS NOT NULL)))),
    CONSTRAINT asset_kind_ck CHECK (((kind)::text = ANY ((ARRAY['source'::character varying, 'corrected'::character varying, 'standardized'::character varying, 'photo'::character varying, 'svg'::character varying, 'semantic'::character varying, 'index'::character varying, 'capture'::character varying])::text[]))),
    CONSTRAINT asset_not_own_source CHECK ((NOT ((id = source_asset_id) AND (source_asset_id IS NOT NULL)))),
    CONSTRAINT asset_size_ck CHECK ((byte_size > 0)),
    CONSTRAINT maps_asset_byte_size_check CHECK ((byte_size >= 0)),
    CONSTRAINT maps_asset_height_check CHECK ((height >= 0)),
    CONSTRAINT maps_asset_width_check CHECK ((width >= 0))
);


--
-- Name: maps_auditevent; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.maps_auditevent (
    id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    action character varying(80) NOT NULL,
    details jsonb NOT NULL,
    actor_id bigint NOT NULL,
    target_id uuid NOT NULL,
    revision_id uuid
);


--
-- Name: maps_building; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.maps_building (
    id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    name character varying(200) NOT NULL,
    slug character varying(200) NOT NULL,
    address text NOT NULL,
    latitude numeric(9,6),
    longitude numeric(9,6),
    created_by_id bigint NOT NULL,
    CONSTRAINT building_coordinate_pair CHECK ((((latitude IS NULL) AND (longitude IS NULL)) OR ((latitude IS NOT NULL) AND ((latitude >= ('-90'::integer)::numeric) AND (latitude <= (90)::numeric)) AND (longitude IS NOT NULL) AND ((longitude >= ('-180'::integer)::numeric) AND (longitude <= (180)::numeric)))))
);


--
-- Name: maps_changeset; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.maps_changeset (
    id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    idempotency_key uuid NOT NULL,
    operations jsonb NOT NULL,
    inverse_operations jsonb NOT NULL,
    source character varying(10) NOT NULL,
    provenance jsonb NOT NULL,
    actor_id bigint NOT NULL,
    contribution_id uuid NOT NULL,
    base_revision_id uuid NOT NULL,
    result_revision_id uuid NOT NULL,
    CONSTRAINT change_distinct_revisions_ck CHECK ((NOT (base_revision_id = result_revision_id))),
    CONSTRAINT change_source_ck CHECK (((source)::text = ANY ((ARRAY['manual'::character varying, 'agent'::character varying])::text[])))
);


--
-- Name: maps_contribution; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.maps_contribution (
    id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    title character varying(200) NOT NULL,
    status character varying(20) NOT NULL,
    lock_version integer NOT NULL,
    submitted_at timestamp with time zone,
    author_id bigint NOT NULL,
    target_id uuid NOT NULL,
    base_revision_id uuid,
    head_revision_id uuid,
    CONSTRAINT contribution_status_ck CHECK (((status)::text = ANY ((ARRAY['draft'::character varying, 'submitted'::character varying, 'changes_requested'::character varying, 'rejected'::character varying, 'merged'::character varying])::text[]))),
    CONSTRAINT maps_contribution_lock_version_check CHECK ((lock_version >= 0))
);


--
-- Name: maps_edge; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.maps_edge (
    id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    stable_id uuid NOT NULL,
    cost numeric(16,6) NOT NULL,
    distance_metres numeric(12,3),
    is_open boolean NOT NULL,
    is_verified boolean NOT NULL,
    restrictions jsonb NOT NULL,
    provenance jsonb NOT NULL,
    from_node_id uuid NOT NULL,
    to_node_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    CONSTRAINT edge_cost_ck CHECK ((cost >= (0)::numeric)),
    CONSTRAINT edge_distance_ck CHECK (((distance_metres IS NULL) OR (distance_metres >= (0)::numeric))),
    CONSTRAINT edge_no_self_loop_ck CHECK ((NOT (from_node_id = to_node_id)))
);


--
-- Name: maps_floor; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.maps_floor (
    id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    code character varying(50) NOT NULL,
    name character varying(200) NOT NULL,
    sort_order integer NOT NULL,
    building_id uuid NOT NULL
);


--
-- Name: maps_mapobject; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.maps_mapobject (
    id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    stable_id uuid NOT NULL,
    kind character varying(30) NOT NULL,
    revision_id uuid NOT NULL
);


--
-- Name: maps_maptarget; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.maps_maptarget (
    id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    title character varying(200) NOT NULL,
    instructions text NOT NULL,
    status character varying(12) NOT NULL,
    archived_at timestamp with time zone,
    created_by_id bigint NOT NULL,
    floor_id uuid NOT NULL,
    CONSTRAINT target_archive_time_ck CHECK ((((archived_at IS NULL) AND ((status)::text = 'open'::text)) OR ((archived_at IS NOT NULL) AND ((status)::text = 'archived'::text)))),
    CONSTRAINT target_status_ck CHECK (((status)::text = ANY ((ARRAY['open'::character varying, 'archived'::character varying])::text[])))
);


--
-- Name: maps_membership; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.maps_membership (
    id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    role character varying(12) NOT NULL,
    revoked_at timestamp with time zone,
    granted_by_id bigint NOT NULL,
    target_id uuid NOT NULL,
    user_id bigint NOT NULL,
    CONSTRAINT membership_role_ck CHECK (((role)::text = ANY ((ARRAY['admin'::character varying, 'volunteer'::character varying])::text[])))
);


--
-- Name: maps_node; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.maps_node (
    id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    stable_id uuid NOT NULL,
    kind character varying(16) NOT NULL,
    x numeric(16,6) NOT NULL,
    y numeric(16,6) NOT NULL,
    label character varying(200) NOT NULL,
    map_object_id uuid,
    revision_id uuid NOT NULL,
    room_id uuid,
    CONSTRAINT node_kind_ck CHECK (((kind)::text = ANY ((ARRAY['room'::character varying, 'door'::character varying, 'junction'::character varying, 'entrance'::character varying, 'stairs'::character varying, 'lift'::character varying, 'checkpoint'::character varying])::text[]))),
    CONSTRAINT node_room_required_ck CHECK (((NOT ((kind)::text = 'room'::text)) OR (room_id IS NOT NULL)))
);


--
-- Name: maps_publication; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.maps_publication (
    id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    sequence integer NOT NULL,
    is_current boolean NOT NULL,
    invalidated_at timestamp with time zone,
    invalidation_reason text NOT NULL,
    published_by_id bigint NOT NULL,
    target_id uuid NOT NULL,
    approval_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    CONSTRAINT maps_publication_sequence_check CHECK ((sequence >= 0)),
    CONSTRAINT publication_invalidation_ck CHECK ((((invalidated_at IS NULL) AND (invalidation_reason = ''::text)) OR ((invalidated_at IS NOT NULL) AND (NOT is_current) AND (NOT (invalidation_reason = ''::text))))),
    CONSTRAINT publication_sequence_ck CHECK ((sequence > 0))
);


--
-- Name: maps_referencephoto; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.maps_referencephoto (
    id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    stable_id uuid NOT NULL,
    captured_at timestamp with time zone,
    collection_session character varying(100) NOT NULL,
    heading_degrees numeric(6,3),
    status character varying(12) NOT NULL,
    reviewed_at timestamp with time zone,
    capture_context jsonb NOT NULL,
    scene_description text NOT NULL,
    analysis_provenance jsonb NOT NULL,
    asset_id uuid NOT NULL,
    node_id uuid,
    reviewed_by_id bigint,
    revision_id uuid NOT NULL,
    CONSTRAINT reference_heading_ck CHECK (((heading_degrees IS NULL) OR ((heading_degrees >= (0)::numeric) AND (heading_degrees < (360)::numeric)))),
    CONSTRAINT reference_review_ck CHECK (((NOT ((status)::text = 'reviewed'::text)) OR ((node_id IS NOT NULL) AND (reviewed_at IS NOT NULL) AND (reviewed_by_id IS NOT NULL)))),
    CONSTRAINT reference_status_ck CHECK (((status)::text = ANY ((ARRAY['proposed'::character varying, 'reviewed'::character varying, 'rejected'::character varying])::text[])))
);


--
-- Name: maps_review; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.maps_review (
    id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    decision character varying(20) NOT NULL,
    feedback text NOT NULL,
    reviewer_id bigint NOT NULL,
    revision_id uuid NOT NULL,
    CONSTRAINT review_decision_ck CHECK (((decision)::text = ANY ((ARRAY['approved'::character varying, 'changes_requested'::character varying, 'rejected'::character varying])::text[]))),
    CONSTRAINT review_feedback_ck CHECK ((((decision)::text = 'approved'::text) OR (NOT (feedback = ''::text))))
);


--
-- Name: maps_revision; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.maps_revision (
    id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    schema_version integer NOT NULL,
    geometry jsonb NOT NULL,
    coordinate_frame jsonb NOT NULL,
    north_degrees numeric(6,3),
    metres_per_unit numeric(16,9),
    content_hash character varying(64) NOT NULL,
    frozen_at timestamp with time zone,
    contribution_id uuid NOT NULL,
    created_by_id bigint NOT NULL,
    parent_id uuid,
    source_asset_id uuid,
    standardized_asset_id uuid,
    target_id uuid NOT NULL,
    CONSTRAINT maps_revision_schema_version_check CHECK ((schema_version >= 0)),
    CONSTRAINT revision_frozen_hash_ck CHECK (((frozen_at IS NULL) OR (NOT ((content_hash)::text = ''::text)))),
    CONSTRAINT revision_north_ck CHECK (((north_degrees IS NULL) OR ((north_degrees >= (0)::numeric) AND (north_degrees < (360)::numeric)))),
    CONSTRAINT revision_not_own_parent CHECK ((NOT ((id = parent_id) AND (parent_id IS NOT NULL)))),
    CONSTRAINT revision_scale_ck CHECK (((metres_per_unit IS NULL) OR (metres_per_unit > (0)::numeric))),
    CONSTRAINT revision_schema_ck CHECK ((schema_version > 0))
);


--
-- Name: maps_revisionartifact; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.maps_revisionartifact (
    id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    kind character varying(16) NOT NULL,
    state character varying(10) NOT NULL,
    required boolean NOT NULL,
    input_content_hash character varying(64) NOT NULL,
    profile jsonb NOT NULL,
    error_code character varying(80) NOT NULL,
    asset_id uuid,
    revision_id uuid NOT NULL,
    CONSTRAINT artifact_kind_ck CHECK (((kind)::text = ANY ((ARRAY['svg'::character varying, 'semantic'::character varying, 'index'::character varying])::text[]))),
    CONSTRAINT artifact_ready_asset_ck CHECK (((NOT ((state)::text = 'ready'::text)) OR (asset_id IS NOT NULL))),
    CONSTRAINT artifact_state_ck CHECK (((state)::text = ANY ((ARRAY['pending'::character varying, 'ready'::character varying, 'failed'::character varying])::text[])))
);


--
-- Name: maps_room; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.maps_room (
    id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    number character varying(80) NOT NULL,
    name character varying(200) NOT NULL,
    purpose text NOT NULL,
    attributes jsonb NOT NULL,
    provenance jsonb NOT NULL,
    map_object_id uuid NOT NULL,
    revision_id uuid NOT NULL
);


--
-- Name: maps_scenerelationship; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.maps_scenerelationship (
    id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    kind character varying(80) NOT NULL,
    evidence jsonb NOT NULL,
    status character varying(12) NOT NULL,
    reviewed_at timestamp with time zone,
    node_id uuid,
    reference_id uuid NOT NULL,
    reviewed_by_id bigint,
    revision_id uuid NOT NULL,
    room_id uuid,
    CONSTRAINT relationship_review_ck CHECK (((NOT ((status)::text = 'reviewed'::text)) OR ((reviewed_at IS NOT NULL) AND (reviewed_by_id IS NOT NULL)))),
    CONSTRAINT relationship_status_ck CHECK (((status)::text = ANY ((ARRAY['proposed'::character varying, 'reviewed'::character varying, 'rejected'::character varying])::text[])))
);


--
-- Name: navigation_capture; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.navigation_capture (
    id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    sequence integer NOT NULL,
    context_version integer NOT NULL,
    captured_at timestamp with time zone NOT NULL,
    idempotency_key character varying(100) NOT NULL,
    capture_context jsonb NOT NULL,
    asset_id uuid NOT NULL,
    job_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    session_id uuid NOT NULL,
    CONSTRAINT capture_sequence_ck CHECK ((sequence > 0)),
    CONSTRAINT navigation_capture_context_version_check CHECK ((context_version >= 0)),
    CONSTRAINT navigation_capture_sequence_check CHECK ((sequence >= 0))
);


--
-- Name: navigation_localizationresult; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.navigation_localizationresult (
    id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    outcome character varying(12) NOT NULL,
    heading_degrees numeric(6,3),
    heading_confirmed boolean NOT NULL,
    reason_code character varying(80) NOT NULL,
    evidence jsonb NOT NULL,
    retrieval_profile jsonb NOT NULL,
    capture_id uuid NOT NULL,
    node_id uuid,
    revision_id uuid NOT NULL,
    session_id uuid NOT NULL,
    CONSTRAINT result_heading_ck CHECK (((heading_degrees IS NULL) OR ((heading_degrees >= (0)::numeric) AND (heading_degrees < (360)::numeric)))),
    CONSTRAINT result_heading_confirmation_ck CHECK (((NOT heading_confirmed) OR (heading_degrees IS NOT NULL))),
    CONSTRAINT result_node_ck CHECK ((((node_id IS NOT NULL) AND ((outcome)::text = 'accepted'::text)) OR ((NOT ((outcome)::text = 'accepted'::text)) AND (node_id IS NULL)))),
    CONSTRAINT result_outcome_ck CHECK (((outcome)::text = ANY ((ARRAY['accepted'::character varying, 'ambiguous'::character varying, 'rejected'::character varying, 'error'::character varying])::text[])))
);


--
-- Name: navigation_navigationsession; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.navigation_navigationsession (
    id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    token_hash character varying(64) NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    invalidated_at timestamp with time zone,
    context_version integer NOT NULL,
    latest_capture_sequence integer NOT NULL,
    confirmed_result_id uuid,
    destination_id uuid,
    publication_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    CONSTRAINT navigation_navigationsession_context_version_check CHECK ((context_version >= 0)),
    CONSTRAINT navigation_navigationsession_latest_capture_sequence_check CHECK ((latest_capture_sequence >= 0))
);


--
-- Name: navigation_route; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.navigation_route (
    id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    context_version integer NOT NULL,
    steps jsonb NOT NULL,
    restrictions jsonb NOT NULL,
    invalidated_at timestamp with time zone,
    arrived_at timestamp with time zone,
    destination_id uuid NOT NULL,
    localization_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    session_id uuid NOT NULL,
    CONSTRAINT navigation_route_context_version_check CHECK ((context_version >= 0))
);


--
-- Name: accounts_user_groups accounts_user_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts_user_groups
    ADD CONSTRAINT accounts_user_groups_pkey PRIMARY KEY (id);


--
-- Name: accounts_user_groups accounts_user_groups_user_id_group_id_59c0b32f_uniq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts_user_groups
    ADD CONSTRAINT accounts_user_groups_user_id_group_id_59c0b32f_uniq UNIQUE (user_id, group_id);


--
-- Name: accounts_user accounts_user_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts_user
    ADD CONSTRAINT accounts_user_pkey PRIMARY KEY (id);


--
-- Name: accounts_user_user_permissions accounts_user_user_permi_user_id_permission_id_2ab516c2_uniq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts_user_user_permissions
    ADD CONSTRAINT accounts_user_user_permi_user_id_permission_id_2ab516c2_uniq UNIQUE (user_id, permission_id);


--
-- Name: accounts_user_user_permissions accounts_user_user_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts_user_user_permissions
    ADD CONSTRAINT accounts_user_user_permissions_pkey PRIMARY KEY (id);


--
-- Name: accounts_user accounts_user_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts_user
    ADD CONSTRAINT accounts_user_username_key UNIQUE (username);


--
-- Name: maps_revisionartifact artifact_kind_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_revisionartifact
    ADD CONSTRAINT artifact_kind_uq UNIQUE (revision_id, kind);


--
-- Name: maps_asset asset_target_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_asset
    ADD CONSTRAINT asset_target_key UNIQUE (id, target_id);


--
-- Name: jobs_jobattempt attempt_number_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs_jobattempt
    ADD CONSTRAINT attempt_number_uq UNIQUE (job_id, number);


--
-- Name: auth_group auth_group_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_group
    ADD CONSTRAINT auth_group_name_key UNIQUE (name);


--
-- Name: auth_group_permissions auth_group_permissions_group_id_permission_id_0cd325b0_uniq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_group_permissions
    ADD CONSTRAINT auth_group_permissions_group_id_permission_id_0cd325b0_uniq UNIQUE (group_id, permission_id);


--
-- Name: auth_group_permissions auth_group_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_group_permissions
    ADD CONSTRAINT auth_group_permissions_pkey PRIMARY KEY (id);


--
-- Name: auth_group auth_group_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_group
    ADD CONSTRAINT auth_group_pkey PRIMARY KEY (id);


--
-- Name: auth_permission auth_permission_content_type_id_codename_01ab375a_uniq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_permission
    ADD CONSTRAINT auth_permission_content_type_id_codename_01ab375a_uniq UNIQUE (content_type_id, codename);


--
-- Name: auth_permission auth_permission_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_permission
    ADD CONSTRAINT auth_permission_pkey PRIMARY KEY (id);


--
-- Name: navigation_capture capture_idempotency_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_capture
    ADD CONSTRAINT capture_idempotency_uq UNIQUE (session_id, idempotency_key);


--
-- Name: navigation_capture capture_revision_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_capture
    ADD CONSTRAINT capture_revision_key UNIQUE (id, revision_id);


--
-- Name: navigation_capture capture_sequence_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_capture
    ADD CONSTRAINT capture_sequence_uq UNIQUE (session_id, sequence);


--
-- Name: navigation_capture capture_session_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_capture
    ADD CONSTRAINT capture_session_key UNIQUE (id, session_id);


--
-- Name: maps_changeset change_idempotency_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_changeset
    ADD CONSTRAINT change_idempotency_uq UNIQUE (contribution_id, idempotency_key);


--
-- Name: maps_contribution contribution_target_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_contribution
    ADD CONSTRAINT contribution_target_key UNIQUE (id, target_id);


--
-- Name: django_admin_log django_admin_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.django_admin_log
    ADD CONSTRAINT django_admin_log_pkey PRIMARY KEY (id);


--
-- Name: django_content_type django_content_type_app_label_model_76bd3d3b_uniq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.django_content_type
    ADD CONSTRAINT django_content_type_app_label_model_76bd3d3b_uniq UNIQUE (app_label, model);


--
-- Name: django_content_type django_content_type_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.django_content_type
    ADD CONSTRAINT django_content_type_pkey PRIMARY KEY (id);


--
-- Name: django_migrations django_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.django_migrations
    ADD CONSTRAINT django_migrations_pkey PRIMARY KEY (id);


--
-- Name: django_session django_session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.django_session
    ADD CONSTRAINT django_session_pkey PRIMARY KEY (session_key);


--
-- Name: maps_edge edge_direction_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_edge
    ADD CONSTRAINT edge_direction_uq UNIQUE (revision_id, from_node_id, to_node_id);


--
-- Name: maps_edge edge_revision_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_edge
    ADD CONSTRAINT edge_revision_key UNIQUE (id, revision_id);


--
-- Name: maps_edge edge_stable_id_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_edge
    ADD CONSTRAINT edge_stable_id_uq UNIQUE (revision_id, stable_id);


--
-- Name: maps_floor floor_code_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_floor
    ADD CONSTRAINT floor_code_uq UNIQUE (building_id, code);


--
-- Name: jobs_job job_idempotency_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs_job
    ADD CONSTRAINT job_idempotency_uq UNIQUE (idempotency_scope, idempotency_key);


--
-- Name: jobs_job job_revision_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs_job
    ADD CONSTRAINT job_revision_key UNIQUE (id, revision_id);


--
-- Name: jobs_job job_session_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs_job
    ADD CONSTRAINT job_session_key UNIQUE (id, session_id);


--
-- Name: jobs_job jobs_job_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs_job
    ADD CONSTRAINT jobs_job_pkey PRIMARY KEY (id);


--
-- Name: jobs_jobattempt jobs_jobattempt_lease_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs_jobattempt
    ADD CONSTRAINT jobs_jobattempt_lease_token_key UNIQUE (lease_token);


--
-- Name: jobs_jobattempt jobs_jobattempt_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs_jobattempt
    ADD CONSTRAINT jobs_jobattempt_pkey PRIMARY KEY (id);


--
-- Name: maps_asset maps_asset_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_asset
    ADD CONSTRAINT maps_asset_pkey PRIMARY KEY (id);


--
-- Name: maps_asset maps_asset_storage_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_asset
    ADD CONSTRAINT maps_asset_storage_key_key UNIQUE (storage_key);


--
-- Name: maps_auditevent maps_auditevent_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_auditevent
    ADD CONSTRAINT maps_auditevent_pkey PRIMARY KEY (id);


--
-- Name: maps_building maps_building_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_building
    ADD CONSTRAINT maps_building_pkey PRIMARY KEY (id);


--
-- Name: maps_building maps_building_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_building
    ADD CONSTRAINT maps_building_slug_key UNIQUE (slug);


--
-- Name: maps_changeset maps_changeset_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_changeset
    ADD CONSTRAINT maps_changeset_pkey PRIMARY KEY (id);


--
-- Name: maps_changeset maps_changeset_result_revision_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_changeset
    ADD CONSTRAINT maps_changeset_result_revision_id_key UNIQUE (result_revision_id);


--
-- Name: maps_contribution maps_contribution_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_contribution
    ADD CONSTRAINT maps_contribution_pkey PRIMARY KEY (id);


--
-- Name: maps_edge maps_edge_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_edge
    ADD CONSTRAINT maps_edge_pkey PRIMARY KEY (id);


--
-- Name: maps_floor maps_floor_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_floor
    ADD CONSTRAINT maps_floor_pkey PRIMARY KEY (id);


--
-- Name: maps_mapobject maps_mapobject_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_mapobject
    ADD CONSTRAINT maps_mapobject_pkey PRIMARY KEY (id);


--
-- Name: maps_maptarget maps_maptarget_floor_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_maptarget
    ADD CONSTRAINT maps_maptarget_floor_id_key UNIQUE (floor_id);


--
-- Name: maps_maptarget maps_maptarget_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_maptarget
    ADD CONSTRAINT maps_maptarget_pkey PRIMARY KEY (id);


--
-- Name: maps_membership maps_membership_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_membership
    ADD CONSTRAINT maps_membership_pkey PRIMARY KEY (id);


--
-- Name: maps_node maps_node_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_node
    ADD CONSTRAINT maps_node_pkey PRIMARY KEY (id);


--
-- Name: maps_publication maps_publication_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_publication
    ADD CONSTRAINT maps_publication_pkey PRIMARY KEY (id);


--
-- Name: maps_publication maps_publication_revision_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_publication
    ADD CONSTRAINT maps_publication_revision_id_key UNIQUE (revision_id);


--
-- Name: maps_referencephoto maps_referencephoto_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_referencephoto
    ADD CONSTRAINT maps_referencephoto_pkey PRIMARY KEY (id);


--
-- Name: maps_review maps_review_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_review
    ADD CONSTRAINT maps_review_pkey PRIMARY KEY (id);


--
-- Name: maps_revision maps_revision_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_revision
    ADD CONSTRAINT maps_revision_pkey PRIMARY KEY (id);


--
-- Name: maps_revisionartifact maps_revisionartifact_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_revisionartifact
    ADD CONSTRAINT maps_revisionartifact_pkey PRIMARY KEY (id);


--
-- Name: maps_room maps_room_map_object_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_room
    ADD CONSTRAINT maps_room_map_object_id_key UNIQUE (map_object_id);


--
-- Name: maps_room maps_room_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_room
    ADD CONSTRAINT maps_room_pkey PRIMARY KEY (id);


--
-- Name: maps_scenerelationship maps_scenerelationship_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_scenerelationship
    ADD CONSTRAINT maps_scenerelationship_pkey PRIMARY KEY (id);


--
-- Name: maps_membership membership_user_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_membership
    ADD CONSTRAINT membership_user_uq UNIQUE (target_id, user_id);


--
-- Name: navigation_capture navigation_capture_asset_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_capture
    ADD CONSTRAINT navigation_capture_asset_id_key UNIQUE (asset_id);


--
-- Name: navigation_capture navigation_capture_job_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_capture
    ADD CONSTRAINT navigation_capture_job_id_key UNIQUE (job_id);


--
-- Name: navigation_capture navigation_capture_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_capture
    ADD CONSTRAINT navigation_capture_pkey PRIMARY KEY (id);


--
-- Name: navigation_localizationresult navigation_localizationresult_capture_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_localizationresult
    ADD CONSTRAINT navigation_localizationresult_capture_id_key UNIQUE (capture_id);


--
-- Name: navigation_localizationresult navigation_localizationresult_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_localizationresult
    ADD CONSTRAINT navigation_localizationresult_pkey PRIMARY KEY (id);


--
-- Name: navigation_navigationsession navigation_navigationsession_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_navigationsession
    ADD CONSTRAINT navigation_navigationsession_pkey PRIMARY KEY (id);


--
-- Name: navigation_navigationsession navigation_navigationsession_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_navigationsession
    ADD CONSTRAINT navigation_navigationsession_token_hash_key UNIQUE (token_hash);


--
-- Name: navigation_route navigation_route_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_route
    ADD CONSTRAINT navigation_route_pkey PRIMARY KEY (id);


--
-- Name: maps_node node_revision_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_node
    ADD CONSTRAINT node_revision_key UNIQUE (id, revision_id);


--
-- Name: maps_node node_stable_id_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_node
    ADD CONSTRAINT node_stable_id_uq UNIQUE (revision_id, stable_id);


--
-- Name: maps_mapobject object_revision_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_mapobject
    ADD CONSTRAINT object_revision_key UNIQUE (id, revision_id);


--
-- Name: maps_mapobject object_stable_id_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_mapobject
    ADD CONSTRAINT object_stable_id_uq UNIQUE (revision_id, stable_id);


--
-- Name: maps_publication publication_revision_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_publication
    ADD CONSTRAINT publication_revision_key UNIQUE (id, revision_id);


--
-- Name: maps_publication publication_sequence_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_publication
    ADD CONSTRAINT publication_sequence_uq UNIQUE (target_id, sequence);


--
-- Name: maps_referencephoto reference_revision_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_referencephoto
    ADD CONSTRAINT reference_revision_key UNIQUE (id, revision_id);


--
-- Name: maps_referencephoto reference_stable_id_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_referencephoto
    ADD CONSTRAINT reference_stable_id_uq UNIQUE (revision_id, stable_id);


--
-- Name: navigation_localizationresult result_revision_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_localizationresult
    ADD CONSTRAINT result_revision_key UNIQUE (id, revision_id);


--
-- Name: navigation_localizationresult result_session_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_localizationresult
    ADD CONSTRAINT result_session_key UNIQUE (id, session_id);


--
-- Name: maps_review review_revision_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_review
    ADD CONSTRAINT review_revision_key UNIQUE (id, revision_id);


--
-- Name: maps_revision revision_contribution_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_revision
    ADD CONSTRAINT revision_contribution_key UNIQUE (id, contribution_id);


--
-- Name: maps_revision revision_target_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_revision
    ADD CONSTRAINT revision_target_key UNIQUE (id, target_id);


--
-- Name: maps_room room_revision_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_room
    ADD CONSTRAINT room_revision_key UNIQUE (id, revision_id);


--
-- Name: navigation_navigationsession session_revision_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_navigationsession
    ADD CONSTRAINT session_revision_key UNIQUE (id, revision_id);


--
-- Name: accounts_user_groups_group_id_bd11a704; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX accounts_user_groups_group_id_bd11a704 ON public.accounts_user_groups USING btree (group_id);


--
-- Name: accounts_user_groups_user_id_52b62117; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX accounts_user_groups_user_id_52b62117 ON public.accounts_user_groups USING btree (user_id);


--
-- Name: accounts_user_user_permissions_permission_id_113bb443; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX accounts_user_user_permissions_permission_id_113bb443 ON public.accounts_user_user_permissions USING btree (permission_id);


--
-- Name: accounts_user_user_permissions_user_id_e4f0a161; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX accounts_user_user_permissions_user_id_e4f0a161 ON public.accounts_user_user_permissions USING btree (user_id);


--
-- Name: accounts_user_username_6088629e_like; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX accounts_user_username_6088629e_like ON public.accounts_user USING btree (username varchar_pattern_ops);


--
-- Name: audit_timeline_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_timeline_idx ON public.maps_auditevent USING btree (target_id, created_at);


--
-- Name: auth_group_name_a6ea08ec_like; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_group_name_a6ea08ec_like ON public.auth_group USING btree (name varchar_pattern_ops);


--
-- Name: auth_group_permissions_group_id_b120cbf9; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_group_permissions_group_id_b120cbf9 ON public.auth_group_permissions USING btree (group_id);


--
-- Name: auth_group_permissions_permission_id_84c5c92e; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_group_permissions_permission_id_84c5c92e ON public.auth_group_permissions USING btree (permission_id);


--
-- Name: auth_permission_content_type_id_2f476e4b; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_permission_content_type_id_2f476e4b ON public.auth_permission USING btree (content_type_id);


--
-- Name: contribution_inbox_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contribution_inbox_idx ON public.maps_contribution USING btree (target_id, status, created_at);


--
-- Name: django_admin_log_content_type_id_c4bce8eb; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX django_admin_log_content_type_id_c4bce8eb ON public.django_admin_log USING btree (content_type_id);


--
-- Name: django_admin_log_user_id_c564eba6; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX django_admin_log_user_id_c564eba6 ON public.django_admin_log USING btree (user_id);


--
-- Name: django_session_expire_date_a5c62663; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX django_session_expire_date_a5c62663 ON public.django_session USING btree (expire_date);


--
-- Name: django_session_session_key_c0390e0f_like; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX django_session_session_key_c0390e0f_like ON public.django_session USING btree (session_key varchar_pattern_ops);


--
-- Name: job_dispatch_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX job_dispatch_idx ON public.jobs_job USING btree (state, next_attempt_at);


--
-- Name: job_lease_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX job_lease_idx ON public.jobs_job USING btree (state, lease_expires_at);


--
-- Name: job_queue_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX job_queue_idx ON public.jobs_job USING btree (queue, state, created_at);


--
-- Name: jobs_job_requested_by_id_b12e9296; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jobs_job_requested_by_id_b12e9296 ON public.jobs_job USING btree (requested_by_id);


--
-- Name: jobs_job_revision_id_2d8411d5; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jobs_job_revision_id_2d8411d5 ON public.jobs_job USING btree (revision_id);


--
-- Name: jobs_job_session_id_50333e7e; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jobs_job_session_id_50333e7e ON public.jobs_job USING btree (session_id);


--
-- Name: jobs_job_target_id_fe7a45b4; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jobs_job_target_id_fe7a45b4 ON public.jobs_job USING btree (target_id);


--
-- Name: jobs_jobattempt_job_id_05797094; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jobs_jobattempt_job_id_05797094 ON public.jobs_jobattempt USING btree (job_id);


--
-- Name: maps_asset_source_asset_id_13d10eb3; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_asset_source_asset_id_13d10eb3 ON public.maps_asset USING btree (source_asset_id);


--
-- Name: maps_asset_storage_key_4378a4a3_like; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_asset_storage_key_4378a4a3_like ON public.maps_asset USING btree (storage_key varchar_pattern_ops);


--
-- Name: maps_asset_target_id_5efa80cc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_asset_target_id_5efa80cc ON public.maps_asset USING btree (target_id);


--
-- Name: maps_asset_uploaded_by_id_1674b63e; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_asset_uploaded_by_id_1674b63e ON public.maps_asset USING btree (uploaded_by_id);


--
-- Name: maps_auditevent_actor_id_b190f6d9; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_auditevent_actor_id_b190f6d9 ON public.maps_auditevent USING btree (actor_id);


--
-- Name: maps_auditevent_revision_id_9e1f57f3; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_auditevent_revision_id_9e1f57f3 ON public.maps_auditevent USING btree (revision_id);


--
-- Name: maps_auditevent_target_id_d3d3959f; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_auditevent_target_id_d3d3959f ON public.maps_auditevent USING btree (target_id);


--
-- Name: maps_building_created_by_id_aac81b00; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_building_created_by_id_aac81b00 ON public.maps_building USING btree (created_by_id);


--
-- Name: maps_building_slug_801c0429_like; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_building_slug_801c0429_like ON public.maps_building USING btree (slug varchar_pattern_ops);


--
-- Name: maps_changeset_actor_id_7c91689c; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_changeset_actor_id_7c91689c ON public.maps_changeset USING btree (actor_id);


--
-- Name: maps_changeset_base_revision_id_d3ae1e31; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_changeset_base_revision_id_d3ae1e31 ON public.maps_changeset USING btree (base_revision_id);


--
-- Name: maps_changeset_contribution_id_c6822bc1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_changeset_contribution_id_c6822bc1 ON public.maps_changeset USING btree (contribution_id);


--
-- Name: maps_contribution_author_id_06594584; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_contribution_author_id_06594584 ON public.maps_contribution USING btree (author_id);


--
-- Name: maps_contribution_base_revision_id_f435b3e2; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_contribution_base_revision_id_f435b3e2 ON public.maps_contribution USING btree (base_revision_id);


--
-- Name: maps_contribution_head_revision_id_347da018; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_contribution_head_revision_id_347da018 ON public.maps_contribution USING btree (head_revision_id);


--
-- Name: maps_contribution_target_id_47977dc4; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_contribution_target_id_47977dc4 ON public.maps_contribution USING btree (target_id);


--
-- Name: maps_edge_from_node_id_b101883f; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_edge_from_node_id_b101883f ON public.maps_edge USING btree (from_node_id);


--
-- Name: maps_edge_revision_id_0ba6df3b; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_edge_revision_id_0ba6df3b ON public.maps_edge USING btree (revision_id);


--
-- Name: maps_edge_to_node_id_fa099d9b; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_edge_to_node_id_fa099d9b ON public.maps_edge USING btree (to_node_id);


--
-- Name: maps_floor_building_id_2f5301bf; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_floor_building_id_2f5301bf ON public.maps_floor USING btree (building_id);


--
-- Name: maps_mapobject_revision_id_7613f8d9; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_mapobject_revision_id_7613f8d9 ON public.maps_mapobject USING btree (revision_id);


--
-- Name: maps_maptarget_created_by_id_9d19fd7d; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_maptarget_created_by_id_9d19fd7d ON public.maps_maptarget USING btree (created_by_id);


--
-- Name: maps_membership_granted_by_id_3410ecb9; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_membership_granted_by_id_3410ecb9 ON public.maps_membership USING btree (granted_by_id);


--
-- Name: maps_membership_target_id_cbeafb5f; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_membership_target_id_cbeafb5f ON public.maps_membership USING btree (target_id);


--
-- Name: maps_membership_user_id_3e6d0ba2; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_membership_user_id_3e6d0ba2 ON public.maps_membership USING btree (user_id);


--
-- Name: maps_node_map_object_id_8487718d; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_node_map_object_id_8487718d ON public.maps_node USING btree (map_object_id);


--
-- Name: maps_node_revision_id_1e5a3691; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_node_revision_id_1e5a3691 ON public.maps_node USING btree (revision_id);


--
-- Name: maps_node_room_id_2bdca156; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_node_room_id_2bdca156 ON public.maps_node USING btree (room_id);


--
-- Name: maps_publication_approval_id_2a204c46; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_publication_approval_id_2a204c46 ON public.maps_publication USING btree (approval_id);


--
-- Name: maps_publication_published_by_id_96a372ec; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_publication_published_by_id_96a372ec ON public.maps_publication USING btree (published_by_id);


--
-- Name: maps_publication_target_id_a998e4b3; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_publication_target_id_a998e4b3 ON public.maps_publication USING btree (target_id);


--
-- Name: maps_referencephoto_asset_id_48d1c5d1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_referencephoto_asset_id_48d1c5d1 ON public.maps_referencephoto USING btree (asset_id);


--
-- Name: maps_referencephoto_node_id_745c6843; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_referencephoto_node_id_745c6843 ON public.maps_referencephoto USING btree (node_id);


--
-- Name: maps_referencephoto_reviewed_by_id_e3f024a7; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_referencephoto_reviewed_by_id_e3f024a7 ON public.maps_referencephoto USING btree (reviewed_by_id);


--
-- Name: maps_referencephoto_revision_id_fbf0a171; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_referencephoto_revision_id_fbf0a171 ON public.maps_referencephoto USING btree (revision_id);


--
-- Name: maps_review_reviewer_id_1b402373; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_review_reviewer_id_1b402373 ON public.maps_review USING btree (reviewer_id);


--
-- Name: maps_review_revision_id_f1e4c639; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_review_revision_id_f1e4c639 ON public.maps_review USING btree (revision_id);


--
-- Name: maps_revision_contribution_id_29011268; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_revision_contribution_id_29011268 ON public.maps_revision USING btree (contribution_id);


--
-- Name: maps_revision_created_by_id_9fdebffd; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_revision_created_by_id_9fdebffd ON public.maps_revision USING btree (created_by_id);


--
-- Name: maps_revision_parent_id_41c4bb67; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_revision_parent_id_41c4bb67 ON public.maps_revision USING btree (parent_id);


--
-- Name: maps_revision_source_asset_id_9ed99934; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_revision_source_asset_id_9ed99934 ON public.maps_revision USING btree (source_asset_id);


--
-- Name: maps_revision_standardized_asset_id_5145463c; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_revision_standardized_asset_id_5145463c ON public.maps_revision USING btree (standardized_asset_id);


--
-- Name: maps_revision_target_id_33f98ebd; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_revision_target_id_33f98ebd ON public.maps_revision USING btree (target_id);


--
-- Name: maps_revisionartifact_asset_id_73279c90; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_revisionartifact_asset_id_73279c90 ON public.maps_revisionartifact USING btree (asset_id);


--
-- Name: maps_revisionartifact_revision_id_463ffaba; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_revisionartifact_revision_id_463ffaba ON public.maps_revisionartifact USING btree (revision_id);


--
-- Name: maps_room_revision_id_83260f93; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_room_revision_id_83260f93 ON public.maps_room USING btree (revision_id);


--
-- Name: maps_scenerelationship_node_id_f15eb2c4; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_scenerelationship_node_id_f15eb2c4 ON public.maps_scenerelationship USING btree (node_id);


--
-- Name: maps_scenerelationship_reference_id_ea1e2af1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_scenerelationship_reference_id_ea1e2af1 ON public.maps_scenerelationship USING btree (reference_id);


--
-- Name: maps_scenerelationship_reviewed_by_id_9de27744; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_scenerelationship_reviewed_by_id_9de27744 ON public.maps_scenerelationship USING btree (reviewed_by_id);


--
-- Name: maps_scenerelationship_revision_id_52830c05; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_scenerelationship_revision_id_52830c05 ON public.maps_scenerelationship USING btree (revision_id);


--
-- Name: maps_scenerelationship_room_id_9083cddb; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maps_scenerelationship_room_id_9083cddb ON public.maps_scenerelationship USING btree (room_id);


--
-- Name: navigation_capture_revision_id_84f4abd1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX navigation_capture_revision_id_84f4abd1 ON public.navigation_capture USING btree (revision_id);


--
-- Name: navigation_capture_session_id_fb1b16b9; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX navigation_capture_session_id_fb1b16b9 ON public.navigation_capture USING btree (session_id);


--
-- Name: navigation_localizationresult_node_id_edf40e2b; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX navigation_localizationresult_node_id_edf40e2b ON public.navigation_localizationresult USING btree (node_id);


--
-- Name: navigation_localizationresult_revision_id_d114f8e1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX navigation_localizationresult_revision_id_d114f8e1 ON public.navigation_localizationresult USING btree (revision_id);


--
-- Name: navigation_localizationresult_session_id_ee45072e; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX navigation_localizationresult_session_id_ee45072e ON public.navigation_localizationresult USING btree (session_id);


--
-- Name: navigation_navigationsession_confirmed_result_id_8b0a25b5; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX navigation_navigationsession_confirmed_result_id_8b0a25b5 ON public.navigation_navigationsession USING btree (confirmed_result_id);


--
-- Name: navigation_navigationsession_destination_id_1f69a21d; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX navigation_navigationsession_destination_id_1f69a21d ON public.navigation_navigationsession USING btree (destination_id);


--
-- Name: navigation_navigationsession_publication_id_434aac04; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX navigation_navigationsession_publication_id_434aac04 ON public.navigation_navigationsession USING btree (publication_id);


--
-- Name: navigation_navigationsession_revision_id_ae13693a; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX navigation_navigationsession_revision_id_ae13693a ON public.navigation_navigationsession USING btree (revision_id);


--
-- Name: navigation_navigationsession_token_hash_1e5ad6e9_like; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX navigation_navigationsession_token_hash_1e5ad6e9_like ON public.navigation_navigationsession USING btree (token_hash varchar_pattern_ops);


--
-- Name: navigation_route_destination_id_3cd3ffee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX navigation_route_destination_id_3cd3ffee ON public.navigation_route USING btree (destination_id);


--
-- Name: navigation_route_localization_id_ec0509bb; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX navigation_route_localization_id_ec0509bb ON public.navigation_route USING btree (localization_id);


--
-- Name: navigation_route_revision_id_65bfe430; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX navigation_route_revision_id_65bfe430 ON public.navigation_route USING btree (revision_id);


--
-- Name: navigation_route_session_id_2666af3b; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX navigation_route_session_id_2666af3b ON public.navigation_route USING btree (session_id);


--
-- Name: node_room_destination_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX node_room_destination_uq ON public.maps_node USING btree (revision_id, room_id) WHERE ((kind)::text = 'room'::text);


--
-- Name: publication_current_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX publication_current_uq ON public.maps_publication USING btree (target_id) WHERE is_current;


--
-- Name: room_search_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX room_search_idx ON public.maps_room USING btree (revision_id, number);


--
-- Name: route_history_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX route_history_idx ON public.navigation_route USING btree (session_id, created_at);


--
-- Name: session_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX session_expiry_idx ON public.navigation_navigationsession USING btree (expires_at);


--
-- Name: maps_asset append_only_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER append_only_guard BEFORE DELETE OR UPDATE ON public.maps_asset FOR EACH ROW EXECUTE FUNCTION public.snapway_append_only();


--
-- Name: maps_auditevent append_only_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER append_only_guard BEFORE DELETE OR UPDATE ON public.maps_auditevent FOR EACH ROW EXECUTE FUNCTION public.snapway_append_only();


--
-- Name: maps_changeset append_only_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER append_only_guard BEFORE DELETE OR UPDATE ON public.maps_changeset FOR EACH ROW EXECUTE FUNCTION public.snapway_append_only();


--
-- Name: maps_review append_only_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER append_only_guard BEFORE DELETE OR UPDATE ON public.maps_review FOR EACH ROW EXECUTE FUNCTION public.snapway_append_only();


--
-- Name: navigation_capture append_only_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER append_only_guard BEFORE DELETE OR UPDATE ON public.navigation_capture FOR EACH ROW EXECUTE FUNCTION public.snapway_append_only();


--
-- Name: navigation_localizationresult append_only_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER append_only_guard BEFORE DELETE OR UPDATE ON public.navigation_localizationresult FOR EACH ROW EXECUTE FUNCTION public.snapway_append_only();


--
-- Name: maps_revisionartifact artifact_asset_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER artifact_asset_guard BEFORE INSERT OR UPDATE ON public.maps_revisionartifact FOR EACH ROW EXECUTE FUNCTION public.snapway_asset_scope_guard('');


--
-- Name: maps_revisionartifact artifact_publication_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER artifact_publication_guard BEFORE INSERT OR DELETE OR UPDATE ON public.maps_revisionartifact FOR EACH ROW EXECUTE FUNCTION public.snapway_artifact_guard();


--
-- Name: navigation_capture capture_asset_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER capture_asset_guard BEFORE INSERT OR UPDATE ON public.navigation_capture FOR EACH ROW EXECUTE FUNCTION public.snapway_asset_scope_guard('capture');


--
-- Name: maps_changeset change_base_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER change_base_guard BEFORE INSERT ON public.maps_changeset FOR EACH ROW EXECUTE FUNCTION public.snapway_changeset_guard();


--
-- Name: maps_publication publication_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER publication_guard BEFORE INSERT OR DELETE OR UPDATE ON public.maps_publication FOR EACH ROW EXECUTE FUNCTION public.snapway_publication_guard();


--
-- Name: maps_referencephoto reference_asset_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER reference_asset_guard BEFORE INSERT OR UPDATE ON public.maps_referencephoto FOR EACH ROW EXECUTE FUNCTION public.snapway_asset_scope_guard('photo');


--
-- Name: maps_review review_frozen_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER review_frozen_guard BEFORE INSERT ON public.maps_review FOR EACH ROW EXECUTE FUNCTION public.snapway_review_guard();


--
-- Name: maps_revision revision_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER revision_guard BEFORE INSERT OR DELETE OR UPDATE ON public.maps_revision FOR EACH ROW EXECUTE FUNCTION public.snapway_revision_guard();


--
-- Name: maps_edge snapshot_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER snapshot_guard BEFORE INSERT OR DELETE OR UPDATE ON public.maps_edge FOR EACH ROW EXECUTE FUNCTION public.snapway_snapshot_guard();


--
-- Name: maps_mapobject snapshot_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER snapshot_guard BEFORE INSERT OR DELETE OR UPDATE ON public.maps_mapobject FOR EACH ROW EXECUTE FUNCTION public.snapway_snapshot_guard();


--
-- Name: maps_node snapshot_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER snapshot_guard BEFORE INSERT OR DELETE OR UPDATE ON public.maps_node FOR EACH ROW EXECUTE FUNCTION public.snapway_snapshot_guard();


--
-- Name: maps_referencephoto snapshot_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER snapshot_guard BEFORE INSERT OR DELETE OR UPDATE ON public.maps_referencephoto FOR EACH ROW EXECUTE FUNCTION public.snapway_snapshot_guard();


--
-- Name: maps_room snapshot_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER snapshot_guard BEFORE INSERT OR DELETE OR UPDATE ON public.maps_room FOR EACH ROW EXECUTE FUNCTION public.snapway_snapshot_guard();


--
-- Name: maps_scenerelationship snapshot_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER snapshot_guard BEFORE INSERT OR DELETE OR UPDATE ON public.maps_scenerelationship FOR EACH ROW EXECUTE FUNCTION public.snapway_snapshot_guard();


--
-- Name: accounts_user_groups accounts_user_groups_group_id_bd11a704_fk_auth_group_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts_user_groups
    ADD CONSTRAINT accounts_user_groups_group_id_bd11a704_fk_auth_group_id FOREIGN KEY (group_id) REFERENCES public.auth_group(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: accounts_user_groups accounts_user_groups_user_id_52b62117_fk_accounts_user_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts_user_groups
    ADD CONSTRAINT accounts_user_groups_user_id_52b62117_fk_accounts_user_id FOREIGN KEY (user_id) REFERENCES public.accounts_user(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: accounts_user_user_permissions accounts_user_user_p_permission_id_113bb443_fk_auth_perm; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts_user_user_permissions
    ADD CONSTRAINT accounts_user_user_p_permission_id_113bb443_fk_auth_perm FOREIGN KEY (permission_id) REFERENCES public.auth_permission(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: accounts_user_user_permissions accounts_user_user_p_user_id_e4f0a161_fk_accounts_; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts_user_user_permissions
    ADD CONSTRAINT accounts_user_user_p_user_id_e4f0a161_fk_accounts_ FOREIGN KEY (user_id) REFERENCES public.accounts_user(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_asset asset_source_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_asset
    ADD CONSTRAINT asset_source_scope_fk FOREIGN KEY (source_asset_id, target_id) REFERENCES public.maps_asset(id, target_id) DEFERRABLE;


--
-- Name: maps_auditevent audit_revision_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_auditevent
    ADD CONSTRAINT audit_revision_scope_fk FOREIGN KEY (revision_id, target_id) REFERENCES public.maps_revision(id, target_id) DEFERRABLE;


--
-- Name: auth_group_permissions auth_group_permissio_permission_id_84c5c92e_fk_auth_perm; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_group_permissions
    ADD CONSTRAINT auth_group_permissio_permission_id_84c5c92e_fk_auth_perm FOREIGN KEY (permission_id) REFERENCES public.auth_permission(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: auth_group_permissions auth_group_permissions_group_id_b120cbf9_fk_auth_group_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_group_permissions
    ADD CONSTRAINT auth_group_permissions_group_id_b120cbf9_fk_auth_group_id FOREIGN KEY (group_id) REFERENCES public.auth_group(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: auth_permission auth_permission_content_type_id_2f476e4b_fk_django_co; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_permission
    ADD CONSTRAINT auth_permission_content_type_id_2f476e4b_fk_django_co FOREIGN KEY (content_type_id) REFERENCES public.django_content_type(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: navigation_capture capture_job_revision_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_capture
    ADD CONSTRAINT capture_job_revision_fk FOREIGN KEY (job_id, revision_id) REFERENCES public.jobs_job(id, revision_id) DEFERRABLE;


--
-- Name: navigation_capture capture_job_session_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_capture
    ADD CONSTRAINT capture_job_session_fk FOREIGN KEY (job_id, session_id) REFERENCES public.jobs_job(id, session_id) DEFERRABLE;


--
-- Name: navigation_capture capture_session_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_capture
    ADD CONSTRAINT capture_session_scope_fk FOREIGN KEY (session_id, revision_id) REFERENCES public.navigation_navigationsession(id, revision_id) DEFERRABLE;


--
-- Name: maps_changeset change_result_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_changeset
    ADD CONSTRAINT change_result_scope_fk FOREIGN KEY (result_revision_id, contribution_id) REFERENCES public.maps_revision(id, contribution_id) DEFERRABLE;


--
-- Name: maps_contribution contribution_base_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_contribution
    ADD CONSTRAINT contribution_base_scope_fk FOREIGN KEY (base_revision_id, target_id) REFERENCES public.maps_revision(id, target_id) DEFERRABLE;


--
-- Name: maps_contribution contribution_head_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_contribution
    ADD CONSTRAINT contribution_head_scope_fk FOREIGN KEY (head_revision_id, id) REFERENCES public.maps_revision(id, contribution_id) DEFERRABLE;


--
-- Name: django_admin_log django_admin_log_content_type_id_c4bce8eb_fk_django_co; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.django_admin_log
    ADD CONSTRAINT django_admin_log_content_type_id_c4bce8eb_fk_django_co FOREIGN KEY (content_type_id) REFERENCES public.django_content_type(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: django_admin_log django_admin_log_user_id_c564eba6_fk_accounts_user_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.django_admin_log
    ADD CONSTRAINT django_admin_log_user_id_c564eba6_fk_accounts_user_id FOREIGN KEY (user_id) REFERENCES public.accounts_user(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_edge edge_from_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_edge
    ADD CONSTRAINT edge_from_scope_fk FOREIGN KEY (from_node_id, revision_id) REFERENCES public.maps_node(id, revision_id) DEFERRABLE;


--
-- Name: maps_edge edge_to_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_edge
    ADD CONSTRAINT edge_to_scope_fk FOREIGN KEY (to_node_id, revision_id) REFERENCES public.maps_node(id, revision_id) DEFERRABLE;


--
-- Name: jobs_job job_session_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs_job
    ADD CONSTRAINT job_session_scope_fk FOREIGN KEY (session_id, revision_id) REFERENCES public.navigation_navigationsession(id, revision_id) DEFERRABLE;


--
-- Name: jobs_job job_target_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs_job
    ADD CONSTRAINT job_target_scope_fk FOREIGN KEY (revision_id, target_id) REFERENCES public.maps_revision(id, target_id) DEFERRABLE;


--
-- Name: jobs_job jobs_job_requested_by_id_b12e9296_fk_accounts_user_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs_job
    ADD CONSTRAINT jobs_job_requested_by_id_b12e9296_fk_accounts_user_id FOREIGN KEY (requested_by_id) REFERENCES public.accounts_user(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: jobs_job jobs_job_revision_id_2d8411d5_fk_maps_revision_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs_job
    ADD CONSTRAINT jobs_job_revision_id_2d8411d5_fk_maps_revision_id FOREIGN KEY (revision_id) REFERENCES public.maps_revision(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: jobs_job jobs_job_session_id_50333e7e_fk_navigation_navigationsession_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs_job
    ADD CONSTRAINT jobs_job_session_id_50333e7e_fk_navigation_navigationsession_id FOREIGN KEY (session_id) REFERENCES public.navigation_navigationsession(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: jobs_job jobs_job_target_id_fe7a45b4_fk_maps_maptarget_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs_job
    ADD CONSTRAINT jobs_job_target_id_fe7a45b4_fk_maps_maptarget_id FOREIGN KEY (target_id) REFERENCES public.maps_maptarget(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: jobs_jobattempt jobs_jobattempt_job_id_05797094_fk_jobs_job_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs_jobattempt
    ADD CONSTRAINT jobs_jobattempt_job_id_05797094_fk_jobs_job_id FOREIGN KEY (job_id) REFERENCES public.jobs_job(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_asset maps_asset_source_asset_id_13d10eb3_fk_maps_asset_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_asset
    ADD CONSTRAINT maps_asset_source_asset_id_13d10eb3_fk_maps_asset_id FOREIGN KEY (source_asset_id) REFERENCES public.maps_asset(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_asset maps_asset_target_id_5efa80cc_fk_maps_maptarget_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_asset
    ADD CONSTRAINT maps_asset_target_id_5efa80cc_fk_maps_maptarget_id FOREIGN KEY (target_id) REFERENCES public.maps_maptarget(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_asset maps_asset_uploaded_by_id_1674b63e_fk_accounts_user_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_asset
    ADD CONSTRAINT maps_asset_uploaded_by_id_1674b63e_fk_accounts_user_id FOREIGN KEY (uploaded_by_id) REFERENCES public.accounts_user(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_auditevent maps_auditevent_actor_id_b190f6d9_fk_accounts_user_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_auditevent
    ADD CONSTRAINT maps_auditevent_actor_id_b190f6d9_fk_accounts_user_id FOREIGN KEY (actor_id) REFERENCES public.accounts_user(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_auditevent maps_auditevent_revision_id_9e1f57f3_fk_maps_revision_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_auditevent
    ADD CONSTRAINT maps_auditevent_revision_id_9e1f57f3_fk_maps_revision_id FOREIGN KEY (revision_id) REFERENCES public.maps_revision(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_auditevent maps_auditevent_target_id_d3d3959f_fk_maps_maptarget_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_auditevent
    ADD CONSTRAINT maps_auditevent_target_id_d3d3959f_fk_maps_maptarget_id FOREIGN KEY (target_id) REFERENCES public.maps_maptarget(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_building maps_building_created_by_id_aac81b00_fk_accounts_user_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_building
    ADD CONSTRAINT maps_building_created_by_id_aac81b00_fk_accounts_user_id FOREIGN KEY (created_by_id) REFERENCES public.accounts_user(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_changeset maps_changeset_actor_id_7c91689c_fk_accounts_user_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_changeset
    ADD CONSTRAINT maps_changeset_actor_id_7c91689c_fk_accounts_user_id FOREIGN KEY (actor_id) REFERENCES public.accounts_user(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_changeset maps_changeset_base_revision_id_d3ae1e31_fk_maps_revision_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_changeset
    ADD CONSTRAINT maps_changeset_base_revision_id_d3ae1e31_fk_maps_revision_id FOREIGN KEY (base_revision_id) REFERENCES public.maps_revision(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_changeset maps_changeset_contribution_id_c6822bc1_fk_maps_contribution_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_changeset
    ADD CONSTRAINT maps_changeset_contribution_id_c6822bc1_fk_maps_contribution_id FOREIGN KEY (contribution_id) REFERENCES public.maps_contribution(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_changeset maps_changeset_result_revision_id_d3cbe522_fk_maps_revision_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_changeset
    ADD CONSTRAINT maps_changeset_result_revision_id_d3cbe522_fk_maps_revision_id FOREIGN KEY (result_revision_id) REFERENCES public.maps_revision(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_contribution maps_contribution_author_id_06594584_fk_accounts_user_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_contribution
    ADD CONSTRAINT maps_contribution_author_id_06594584_fk_accounts_user_id FOREIGN KEY (author_id) REFERENCES public.accounts_user(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_contribution maps_contribution_base_revision_id_f435b3e2_fk_maps_revision_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_contribution
    ADD CONSTRAINT maps_contribution_base_revision_id_f435b3e2_fk_maps_revision_id FOREIGN KEY (base_revision_id) REFERENCES public.maps_revision(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_contribution maps_contribution_head_revision_id_347da018_fk_maps_revision_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_contribution
    ADD CONSTRAINT maps_contribution_head_revision_id_347da018_fk_maps_revision_id FOREIGN KEY (head_revision_id) REFERENCES public.maps_revision(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_contribution maps_contribution_target_id_47977dc4_fk_maps_maptarget_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_contribution
    ADD CONSTRAINT maps_contribution_target_id_47977dc4_fk_maps_maptarget_id FOREIGN KEY (target_id) REFERENCES public.maps_maptarget(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_edge maps_edge_from_node_id_b101883f_fk_maps_node_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_edge
    ADD CONSTRAINT maps_edge_from_node_id_b101883f_fk_maps_node_id FOREIGN KEY (from_node_id) REFERENCES public.maps_node(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_edge maps_edge_revision_id_0ba6df3b_fk_maps_revision_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_edge
    ADD CONSTRAINT maps_edge_revision_id_0ba6df3b_fk_maps_revision_id FOREIGN KEY (revision_id) REFERENCES public.maps_revision(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_edge maps_edge_to_node_id_fa099d9b_fk_maps_node_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_edge
    ADD CONSTRAINT maps_edge_to_node_id_fa099d9b_fk_maps_node_id FOREIGN KEY (to_node_id) REFERENCES public.maps_node(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_floor maps_floor_building_id_2f5301bf_fk_maps_building_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_floor
    ADD CONSTRAINT maps_floor_building_id_2f5301bf_fk_maps_building_id FOREIGN KEY (building_id) REFERENCES public.maps_building(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_mapobject maps_mapobject_revision_id_7613f8d9_fk_maps_revision_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_mapobject
    ADD CONSTRAINT maps_mapobject_revision_id_7613f8d9_fk_maps_revision_id FOREIGN KEY (revision_id) REFERENCES public.maps_revision(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_maptarget maps_maptarget_created_by_id_9d19fd7d_fk_accounts_user_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_maptarget
    ADD CONSTRAINT maps_maptarget_created_by_id_9d19fd7d_fk_accounts_user_id FOREIGN KEY (created_by_id) REFERENCES public.accounts_user(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_maptarget maps_maptarget_floor_id_032b4f8d_fk_maps_floor_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_maptarget
    ADD CONSTRAINT maps_maptarget_floor_id_032b4f8d_fk_maps_floor_id FOREIGN KEY (floor_id) REFERENCES public.maps_floor(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_membership maps_membership_granted_by_id_3410ecb9_fk_accounts_user_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_membership
    ADD CONSTRAINT maps_membership_granted_by_id_3410ecb9_fk_accounts_user_id FOREIGN KEY (granted_by_id) REFERENCES public.accounts_user(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_membership maps_membership_target_id_cbeafb5f_fk_maps_maptarget_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_membership
    ADD CONSTRAINT maps_membership_target_id_cbeafb5f_fk_maps_maptarget_id FOREIGN KEY (target_id) REFERENCES public.maps_maptarget(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_membership maps_membership_user_id_3e6d0ba2_fk_accounts_user_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_membership
    ADD CONSTRAINT maps_membership_user_id_3e6d0ba2_fk_accounts_user_id FOREIGN KEY (user_id) REFERENCES public.accounts_user(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_node maps_node_map_object_id_8487718d_fk_maps_mapobject_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_node
    ADD CONSTRAINT maps_node_map_object_id_8487718d_fk_maps_mapobject_id FOREIGN KEY (map_object_id) REFERENCES public.maps_mapobject(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_node maps_node_revision_id_1e5a3691_fk_maps_revision_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_node
    ADD CONSTRAINT maps_node_revision_id_1e5a3691_fk_maps_revision_id FOREIGN KEY (revision_id) REFERENCES public.maps_revision(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_node maps_node_room_id_2bdca156_fk_maps_room_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_node
    ADD CONSTRAINT maps_node_room_id_2bdca156_fk_maps_room_id FOREIGN KEY (room_id) REFERENCES public.maps_room(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_publication maps_publication_approval_id_2a204c46_fk_maps_review_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_publication
    ADD CONSTRAINT maps_publication_approval_id_2a204c46_fk_maps_review_id FOREIGN KEY (approval_id) REFERENCES public.maps_review(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_publication maps_publication_published_by_id_96a372ec_fk_accounts_user_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_publication
    ADD CONSTRAINT maps_publication_published_by_id_96a372ec_fk_accounts_user_id FOREIGN KEY (published_by_id) REFERENCES public.accounts_user(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_publication maps_publication_revision_id_8cea731f_fk_maps_revision_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_publication
    ADD CONSTRAINT maps_publication_revision_id_8cea731f_fk_maps_revision_id FOREIGN KEY (revision_id) REFERENCES public.maps_revision(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_publication maps_publication_target_id_a998e4b3_fk_maps_maptarget_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_publication
    ADD CONSTRAINT maps_publication_target_id_a998e4b3_fk_maps_maptarget_id FOREIGN KEY (target_id) REFERENCES public.maps_maptarget(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_referencephoto maps_referencephoto_asset_id_48d1c5d1_fk_maps_asset_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_referencephoto
    ADD CONSTRAINT maps_referencephoto_asset_id_48d1c5d1_fk_maps_asset_id FOREIGN KEY (asset_id) REFERENCES public.maps_asset(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_referencephoto maps_referencephoto_node_id_745c6843_fk_maps_node_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_referencephoto
    ADD CONSTRAINT maps_referencephoto_node_id_745c6843_fk_maps_node_id FOREIGN KEY (node_id) REFERENCES public.maps_node(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_referencephoto maps_referencephoto_reviewed_by_id_e3f024a7_fk_accounts_user_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_referencephoto
    ADD CONSTRAINT maps_referencephoto_reviewed_by_id_e3f024a7_fk_accounts_user_id FOREIGN KEY (reviewed_by_id) REFERENCES public.accounts_user(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_referencephoto maps_referencephoto_revision_id_fbf0a171_fk_maps_revision_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_referencephoto
    ADD CONSTRAINT maps_referencephoto_revision_id_fbf0a171_fk_maps_revision_id FOREIGN KEY (revision_id) REFERENCES public.maps_revision(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_review maps_review_reviewer_id_1b402373_fk_accounts_user_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_review
    ADD CONSTRAINT maps_review_reviewer_id_1b402373_fk_accounts_user_id FOREIGN KEY (reviewer_id) REFERENCES public.accounts_user(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_review maps_review_revision_id_f1e4c639_fk_maps_revision_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_review
    ADD CONSTRAINT maps_review_revision_id_f1e4c639_fk_maps_revision_id FOREIGN KEY (revision_id) REFERENCES public.maps_revision(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_revision maps_revision_contribution_id_29011268_fk_maps_contribution_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_revision
    ADD CONSTRAINT maps_revision_contribution_id_29011268_fk_maps_contribution_id FOREIGN KEY (contribution_id) REFERENCES public.maps_contribution(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_revision maps_revision_created_by_id_9fdebffd_fk_accounts_user_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_revision
    ADD CONSTRAINT maps_revision_created_by_id_9fdebffd_fk_accounts_user_id FOREIGN KEY (created_by_id) REFERENCES public.accounts_user(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_revision maps_revision_parent_id_41c4bb67_fk_maps_revision_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_revision
    ADD CONSTRAINT maps_revision_parent_id_41c4bb67_fk_maps_revision_id FOREIGN KEY (parent_id) REFERENCES public.maps_revision(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_revision maps_revision_source_asset_id_9ed99934_fk_maps_asset_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_revision
    ADD CONSTRAINT maps_revision_source_asset_id_9ed99934_fk_maps_asset_id FOREIGN KEY (source_asset_id) REFERENCES public.maps_asset(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_revision maps_revision_standardized_asset_id_5145463c_fk_maps_asset_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_revision
    ADD CONSTRAINT maps_revision_standardized_asset_id_5145463c_fk_maps_asset_id FOREIGN KEY (standardized_asset_id) REFERENCES public.maps_asset(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_revision maps_revision_target_id_33f98ebd_fk_maps_maptarget_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_revision
    ADD CONSTRAINT maps_revision_target_id_33f98ebd_fk_maps_maptarget_id FOREIGN KEY (target_id) REFERENCES public.maps_maptarget(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_revisionartifact maps_revisionartifact_asset_id_73279c90_fk_maps_asset_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_revisionartifact
    ADD CONSTRAINT maps_revisionartifact_asset_id_73279c90_fk_maps_asset_id FOREIGN KEY (asset_id) REFERENCES public.maps_asset(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_revisionartifact maps_revisionartifact_revision_id_463ffaba_fk_maps_revision_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_revisionartifact
    ADD CONSTRAINT maps_revisionartifact_revision_id_463ffaba_fk_maps_revision_id FOREIGN KEY (revision_id) REFERENCES public.maps_revision(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_room maps_room_map_object_id_d8bcee3f_fk_maps_mapobject_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_room
    ADD CONSTRAINT maps_room_map_object_id_d8bcee3f_fk_maps_mapobject_id FOREIGN KEY (map_object_id) REFERENCES public.maps_mapobject(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_room maps_room_revision_id_83260f93_fk_maps_revision_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_room
    ADD CONSTRAINT maps_room_revision_id_83260f93_fk_maps_revision_id FOREIGN KEY (revision_id) REFERENCES public.maps_revision(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_scenerelationship maps_scenerelationsh_reference_id_ea1e2af1_fk_maps_refe; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_scenerelationship
    ADD CONSTRAINT maps_scenerelationsh_reference_id_ea1e2af1_fk_maps_refe FOREIGN KEY (reference_id) REFERENCES public.maps_referencephoto(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_scenerelationship maps_scenerelationsh_reviewed_by_id_9de27744_fk_accounts_; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_scenerelationship
    ADD CONSTRAINT maps_scenerelationsh_reviewed_by_id_9de27744_fk_accounts_ FOREIGN KEY (reviewed_by_id) REFERENCES public.accounts_user(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_scenerelationship maps_scenerelationship_node_id_f15eb2c4_fk_maps_node_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_scenerelationship
    ADD CONSTRAINT maps_scenerelationship_node_id_f15eb2c4_fk_maps_node_id FOREIGN KEY (node_id) REFERENCES public.maps_node(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_scenerelationship maps_scenerelationship_revision_id_52830c05_fk_maps_revision_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_scenerelationship
    ADD CONSTRAINT maps_scenerelationship_revision_id_52830c05_fk_maps_revision_id FOREIGN KEY (revision_id) REFERENCES public.maps_revision(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_scenerelationship maps_scenerelationship_room_id_9083cddb_fk_maps_room_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_scenerelationship
    ADD CONSTRAINT maps_scenerelationship_room_id_9083cddb_fk_maps_room_id FOREIGN KEY (room_id) REFERENCES public.maps_room(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: navigation_capture navigation_capture_asset_id_1e0d56fa_fk_maps_asset_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_capture
    ADD CONSTRAINT navigation_capture_asset_id_1e0d56fa_fk_maps_asset_id FOREIGN KEY (asset_id) REFERENCES public.maps_asset(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: navigation_capture navigation_capture_job_id_68983ec8_fk_jobs_job_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_capture
    ADD CONSTRAINT navigation_capture_job_id_68983ec8_fk_jobs_job_id FOREIGN KEY (job_id) REFERENCES public.jobs_job(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: navigation_capture navigation_capture_revision_id_84f4abd1_fk_maps_revision_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_capture
    ADD CONSTRAINT navigation_capture_revision_id_84f4abd1_fk_maps_revision_id FOREIGN KEY (revision_id) REFERENCES public.maps_revision(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: navigation_capture navigation_capture_session_id_fb1b16b9_fk_navigatio; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_capture
    ADD CONSTRAINT navigation_capture_session_id_fb1b16b9_fk_navigatio FOREIGN KEY (session_id) REFERENCES public.navigation_navigationsession(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: navigation_localizationresult navigation_localizat_capture_id_591742d5_fk_navigatio; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_localizationresult
    ADD CONSTRAINT navigation_localizat_capture_id_591742d5_fk_navigatio FOREIGN KEY (capture_id) REFERENCES public.navigation_capture(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: navigation_localizationresult navigation_localizat_revision_id_d114f8e1_fk_maps_revi; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_localizationresult
    ADD CONSTRAINT navigation_localizat_revision_id_d114f8e1_fk_maps_revi FOREIGN KEY (revision_id) REFERENCES public.maps_revision(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: navigation_localizationresult navigation_localizat_session_id_ee45072e_fk_navigatio; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_localizationresult
    ADD CONSTRAINT navigation_localizat_session_id_ee45072e_fk_navigatio FOREIGN KEY (session_id) REFERENCES public.navigation_navigationsession(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: navigation_localizationresult navigation_localizationresult_node_id_edf40e2b_fk_maps_node_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_localizationresult
    ADD CONSTRAINT navigation_localizationresult_node_id_edf40e2b_fk_maps_node_id FOREIGN KEY (node_id) REFERENCES public.maps_node(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: navigation_navigationsession navigation_navigatio_confirmed_result_id_8b0a25b5_fk_navigatio; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_navigationsession
    ADD CONSTRAINT navigation_navigatio_confirmed_result_id_8b0a25b5_fk_navigatio FOREIGN KEY (confirmed_result_id) REFERENCES public.navigation_localizationresult(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: navigation_navigationsession navigation_navigatio_destination_id_1f69a21d_fk_maps_node; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_navigationsession
    ADD CONSTRAINT navigation_navigatio_destination_id_1f69a21d_fk_maps_node FOREIGN KEY (destination_id) REFERENCES public.maps_node(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: navigation_navigationsession navigation_navigatio_publication_id_434aac04_fk_maps_publ; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_navigationsession
    ADD CONSTRAINT navigation_navigatio_publication_id_434aac04_fk_maps_publ FOREIGN KEY (publication_id) REFERENCES public.maps_publication(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: navigation_navigationsession navigation_navigatio_revision_id_ae13693a_fk_maps_revi; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_navigationsession
    ADD CONSTRAINT navigation_navigatio_revision_id_ae13693a_fk_maps_revi FOREIGN KEY (revision_id) REFERENCES public.maps_revision(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: navigation_route navigation_route_destination_id_3cd3ffee_fk_maps_node_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_route
    ADD CONSTRAINT navigation_route_destination_id_3cd3ffee_fk_maps_node_id FOREIGN KEY (destination_id) REFERENCES public.maps_node(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: navigation_route navigation_route_localization_id_ec0509bb_fk_navigatio; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_route
    ADD CONSTRAINT navigation_route_localization_id_ec0509bb_fk_navigatio FOREIGN KEY (localization_id) REFERENCES public.navigation_localizationresult(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: navigation_route navigation_route_revision_id_65bfe430_fk_maps_revision_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_route
    ADD CONSTRAINT navigation_route_revision_id_65bfe430_fk_maps_revision_id FOREIGN KEY (revision_id) REFERENCES public.maps_revision(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: navigation_route navigation_route_session_id_2666af3b_fk_navigatio; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_route
    ADD CONSTRAINT navigation_route_session_id_2666af3b_fk_navigatio FOREIGN KEY (session_id) REFERENCES public.navigation_navigationsession(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: maps_node node_object_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_node
    ADD CONSTRAINT node_object_scope_fk FOREIGN KEY (map_object_id, revision_id) REFERENCES public.maps_mapobject(id, revision_id) DEFERRABLE;


--
-- Name: maps_node node_room_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_node
    ADD CONSTRAINT node_room_scope_fk FOREIGN KEY (room_id, revision_id) REFERENCES public.maps_room(id, revision_id) DEFERRABLE;


--
-- Name: maps_publication publication_approval_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_publication
    ADD CONSTRAINT publication_approval_scope_fk FOREIGN KEY (approval_id, revision_id) REFERENCES public.maps_review(id, revision_id) DEFERRABLE;


--
-- Name: maps_publication publication_target_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_publication
    ADD CONSTRAINT publication_target_scope_fk FOREIGN KEY (revision_id, target_id) REFERENCES public.maps_revision(id, target_id) DEFERRABLE;


--
-- Name: maps_referencephoto reference_node_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_referencephoto
    ADD CONSTRAINT reference_node_scope_fk FOREIGN KEY (node_id, revision_id) REFERENCES public.maps_node(id, revision_id) DEFERRABLE;


--
-- Name: maps_scenerelationship relationship_node_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_scenerelationship
    ADD CONSTRAINT relationship_node_scope_fk FOREIGN KEY (node_id, revision_id) REFERENCES public.maps_node(id, revision_id) DEFERRABLE;


--
-- Name: maps_scenerelationship relationship_photo_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_scenerelationship
    ADD CONSTRAINT relationship_photo_scope_fk FOREIGN KEY (reference_id, revision_id) REFERENCES public.maps_referencephoto(id, revision_id) DEFERRABLE;


--
-- Name: maps_scenerelationship relationship_room_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_scenerelationship
    ADD CONSTRAINT relationship_room_scope_fk FOREIGN KEY (room_id, revision_id) REFERENCES public.maps_room(id, revision_id) DEFERRABLE;


--
-- Name: navigation_localizationresult result_capture_revision_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_localizationresult
    ADD CONSTRAINT result_capture_revision_fk FOREIGN KEY (capture_id, revision_id) REFERENCES public.navigation_capture(id, revision_id) DEFERRABLE;


--
-- Name: navigation_localizationresult result_capture_session_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_localizationresult
    ADD CONSTRAINT result_capture_session_fk FOREIGN KEY (capture_id, session_id) REFERENCES public.navigation_capture(id, session_id) DEFERRABLE;


--
-- Name: navigation_localizationresult result_node_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_localizationresult
    ADD CONSTRAINT result_node_scope_fk FOREIGN KEY (node_id, revision_id) REFERENCES public.maps_node(id, revision_id) DEFERRABLE;


--
-- Name: maps_revision revision_contribution_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_revision
    ADD CONSTRAINT revision_contribution_scope_fk FOREIGN KEY (contribution_id, target_id) REFERENCES public.maps_contribution(id, target_id) DEFERRABLE;


--
-- Name: maps_revision revision_parent_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_revision
    ADD CONSTRAINT revision_parent_scope_fk FOREIGN KEY (parent_id, target_id) REFERENCES public.maps_revision(id, target_id) DEFERRABLE;


--
-- Name: maps_revision revision_source_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_revision
    ADD CONSTRAINT revision_source_scope_fk FOREIGN KEY (source_asset_id, target_id) REFERENCES public.maps_asset(id, target_id) DEFERRABLE;


--
-- Name: maps_revision revision_standardized_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_revision
    ADD CONSTRAINT revision_standardized_scope_fk FOREIGN KEY (standardized_asset_id, target_id) REFERENCES public.maps_asset(id, target_id) DEFERRABLE;


--
-- Name: maps_room room_object_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maps_room
    ADD CONSTRAINT room_object_scope_fk FOREIGN KEY (map_object_id, revision_id) REFERENCES public.maps_mapobject(id, revision_id) DEFERRABLE;


--
-- Name: navigation_route route_destination_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_route
    ADD CONSTRAINT route_destination_scope_fk FOREIGN KEY (destination_id, revision_id) REFERENCES public.maps_node(id, revision_id) DEFERRABLE;


--
-- Name: navigation_route route_result_revision_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_route
    ADD CONSTRAINT route_result_revision_fk FOREIGN KEY (localization_id, revision_id) REFERENCES public.navigation_localizationresult(id, revision_id) DEFERRABLE;


--
-- Name: navigation_route route_result_session_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_route
    ADD CONSTRAINT route_result_session_fk FOREIGN KEY (localization_id, session_id) REFERENCES public.navigation_localizationresult(id, session_id) DEFERRABLE;


--
-- Name: navigation_route route_session_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_route
    ADD CONSTRAINT route_session_scope_fk FOREIGN KEY (session_id, revision_id) REFERENCES public.navigation_navigationsession(id, revision_id) DEFERRABLE;


--
-- Name: navigation_navigationsession session_destination_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_navigationsession
    ADD CONSTRAINT session_destination_scope_fk FOREIGN KEY (destination_id, revision_id) REFERENCES public.maps_node(id, revision_id) DEFERRABLE;


--
-- Name: navigation_navigationsession session_publication_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_navigationsession
    ADD CONSTRAINT session_publication_scope_fk FOREIGN KEY (publication_id, revision_id) REFERENCES public.maps_publication(id, revision_id) DEFERRABLE;


--
-- Name: navigation_navigationsession session_result_revision_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_navigationsession
    ADD CONSTRAINT session_result_revision_fk FOREIGN KEY (confirmed_result_id, revision_id) REFERENCES public.navigation_localizationresult(id, revision_id) DEFERRABLE;


--
-- Name: navigation_navigationsession session_result_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.navigation_navigationsession
    ADD CONSTRAINT session_result_scope_fk FOREIGN KEY (confirmed_result_id, id) REFERENCES public.navigation_localizationresult(id, session_id) DEFERRABLE;


--
-- PostgreSQL database dump complete
--

\unrestrict oNy2IkB2MCyJqnZ6vPb8aaMX6U3YFDG5AfPH3R6biNh2xWIX4Yg89fC717QuDpC

