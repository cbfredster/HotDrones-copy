-- HotDrones telemetry schema for Tiger Cloud (Postgres + TimescaleDB).
--
-- Every row's "time" is  run start + tick seconds,  so one sim tick is one second on the
-- time axis and time_bucket() works the same for a live run and for a headless experiment.
--
-- Statements are separated by lines containing only "-- ;;" and applied one by one by
-- server/tiger.ts. A statement tagged "-- @timescale" is skipped on plain Postgres, and one
-- tagged "-- @plain" is skipped on TimescaleDB (plain views standing in for the continuous
-- aggregates, so the same server and dashboard run against any Postgres).

CREATE TABLE IF NOT EXISTS runs (
  run_id      uuid PRIMARY KEY,
  started_at  timestamptz NOT NULL,
  source      text NOT NULL,            -- live | experiment | challenge
  experiment  text,                     -- experiment condition name, e.g. "range"
  sweep_id    text,                     -- one `npm run experiment -- --db` invocation
  seed        integer NOT NULL,
  mode        text NOT NULL,            -- swarm | central | greedy | none
  comms_range real NOT NULL,
  drones      integer NOT NULL,
  config      jsonb,
  finished    boolean NOT NULL DEFAULT false,
  ticks       integer,
  burnt       integer,
  village_lost boolean,
  drones_lost integer,
  water_dropped integer,
  extinguished_at integer
);
-- ;;
CREATE INDEX IF NOT EXISTS runs_started_idx ON runs (started_at DESC);
-- ;;
CREATE INDEX IF NOT EXISTS runs_sweep_idx ON runs (sweep_id);
-- ;;

-- @timescale
CREATE TABLE IF NOT EXISTS drone_telemetry (
  time     timestamptz NOT NULL,
  run_id   uuid NOT NULL,
  drone_id smallint NOT NULL,
  x real, y real, alt real,
  state    text,
  battery  real, damage real, water real
) WITH (tsdb.hypertable, tsdb.partition_column = 'time', tsdb.segmentby = 'run_id', tsdb.orderby = 'time DESC');
-- ;;
-- @plain
CREATE TABLE IF NOT EXISTS drone_telemetry (
  time     timestamptz NOT NULL,
  run_id   uuid NOT NULL,
  drone_id smallint NOT NULL,
  x real, y real, alt real,
  state    text,
  battery  real, damage real, water real
);
-- ;;
CREATE INDEX IF NOT EXISTS drone_telemetry_run_idx ON drone_telemetry (run_id, time DESC);
-- ;;

-- @timescale
CREATE TABLE IF NOT EXISTS fire_metrics (
  time        timestamptz NOT NULL,
  run_id      uuid NOT NULL,
  tick        integer NOT NULL,
  burning     integer, burnt integer, thick_smoke integer,
  comms_groups smallint, links smallint,
  base_online boolean,
  drones_alive smallint
) WITH (tsdb.hypertable, tsdb.partition_column = 'time', tsdb.segmentby = 'run_id', tsdb.orderby = 'time DESC');
-- ;;
-- @plain
CREATE TABLE IF NOT EXISTS fire_metrics (
  time        timestamptz NOT NULL,
  run_id      uuid NOT NULL,
  tick        integer NOT NULL,
  burning     integer, burnt integer, thick_smoke integer,
  comms_groups smallint, links smallint,
  base_online boolean,
  drones_alive smallint
);
-- ;;
CREATE INDEX IF NOT EXISTS fire_metrics_run_idx ON fire_metrics (run_id, time DESC);
-- ;;

-- @timescale
CREATE TABLE IF NOT EXISTS events (
  time     timestamptz NOT NULL,
  run_id   uuid NOT NULL,
  tick     integer NOT NULL,
  type     text NOT NULL,
  drone_id smallint,
  data     jsonb
) WITH (tsdb.hypertable, tsdb.partition_column = 'time', tsdb.segmentby = 'run_id', tsdb.orderby = 'time DESC');
-- ;;
-- @plain
CREATE TABLE IF NOT EXISTS events (
  time     timestamptz NOT NULL,
  run_id   uuid NOT NULL,
  tick     integer NOT NULL,
  type     text NOT NULL,
  drone_id smallint,
  data     jsonb
);
-- ;;
CREATE INDEX IF NOT EXISTS events_run_idx ON events (run_id, time DESC);
-- ;;

-- Finished runs as a time series, so the experiment comparison can be a continuous aggregate too.
-- @timescale
CREATE TABLE IF NOT EXISTS run_results (
  time        timestamptz NOT NULL,     -- when the run started
  run_id      uuid NOT NULL,
  source      text NOT NULL,
  experiment  text NOT NULL DEFAULT '',
  sweep_id    text NOT NULL DEFAULT '',
  mode        text NOT NULL,
  comms_range real NOT NULL,
  seed        integer NOT NULL,
  burnt       integer NOT NULL,
  village_lost integer NOT NULL,        -- 0 / 1
  drones_lost integer NOT NULL,
  ticks       integer NOT NULL
) WITH (tsdb.hypertable, tsdb.partition_column = 'time', tsdb.segmentby = 'sweep_id', tsdb.orderby = 'time DESC');
-- ;;
-- @plain
CREATE TABLE IF NOT EXISTS run_results (
  time        timestamptz NOT NULL,
  run_id      uuid NOT NULL,
  source      text NOT NULL,
  experiment  text NOT NULL DEFAULT '',
  sweep_id    text NOT NULL DEFAULT '',
  mode        text NOT NULL,
  comms_range real NOT NULL,
  seed        integer NOT NULL,
  burnt       integer NOT NULL,
  village_lost integer NOT NULL,
  drones_lost integer NOT NULL,
  ticks       integer NOT NULL
);
-- ;;

-- ---------------------------------------------------------------- continuous aggregates
-- The dashboard reads ONLY from these three. materialized_only = false turns on real-time
-- aggregation, so rows newer than the last refresh are included (a live run is always
-- "newer": at 20 ticks/s its timestamps run ahead of the wall clock).

-- Fire growth and connectivity, per run, in 10-second (= 10-tick) buckets.
-- @timescale
CREATE MATERIALIZED VIEW IF NOT EXISTS fire_10s
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT time_bucket(INTERVAL '10 seconds', time) AS bucket, run_id,
       max(tick) AS tick,
       avg(burning) AS burning, max(burnt) AS burnt, avg(thick_smoke) AS thick_smoke,
       avg(comms_groups) AS comms_groups, avg(links) AS links,
       avg(base_online::int) AS base_online, min(drones_alive) AS drones_alive
FROM fire_metrics GROUP BY bucket, run_id
WITH NO DATA;
-- ;;
-- @plain
CREATE OR REPLACE VIEW fire_10s AS
SELECT date_bin(INTERVAL '10 seconds', time, TIMESTAMPTZ '2000-01-01') AS bucket, run_id,
       max(tick) AS tick,
       avg(burning) AS burning, max(burnt) AS burnt, avg(thick_smoke) AS thick_smoke,
       avg(comms_groups) AS comms_groups, avg(links) AS links,
       avg(base_online::int) AS base_online, min(drones_alive) AS drones_alive
FROM fire_metrics GROUP BY 1, run_id;
-- ;;

-- Battery / damage / water spread across the swarm, per run, in 10-second buckets.
-- @timescale
CREATE MATERIALIZED VIEW IF NOT EXISTS swarm_10s
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT time_bucket(INTERVAL '10 seconds', time) AS bucket, run_id,
       min(battery) AS battery_min, avg(battery) AS battery_avg, max(battery) AS battery_max,
       max(damage) AS damage_max, avg(damage) AS damage_avg, avg(water) AS water_avg,
       count(*) AS samples
FROM drone_telemetry GROUP BY bucket, run_id
WITH NO DATA;
-- ;;
-- @plain
CREATE OR REPLACE VIEW swarm_10s AS
SELECT date_bin(INTERVAL '10 seconds', time, TIMESTAMPTZ '2000-01-01') AS bucket, run_id,
       min(battery) AS battery_min, avg(battery) AS battery_avg, max(battery) AS battery_max,
       max(damage) AS damage_max, avg(damage) AS damage_avg, avg(water) AS water_avg,
       count(*) AS samples
FROM drone_telemetry GROUP BY 1, run_id;
-- ;;

-- Experiment comparison: per sweep, experiment, mode and comms range. Sums and counts (not
-- averages), so the dashboard can combine hourly buckets exactly.
-- @timescale
CREATE MATERIALIZED VIEW IF NOT EXISTS experiment_1h
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT time_bucket(INTERVAL '1 hour', time) AS bucket, sweep_id, experiment, mode, comms_range,
       count(*) AS n, sum(burnt) AS burnt_sum, sum(burnt::float8 * burnt) AS burnt_sq_sum,
       sum(village_lost) AS village_lost_sum, sum(drones_lost) AS drones_lost_sum
FROM run_results GROUP BY bucket, sweep_id, experiment, mode, comms_range
WITH NO DATA;
-- ;;
-- @plain
CREATE OR REPLACE VIEW experiment_1h AS
SELECT date_bin(INTERVAL '1 hour', time, TIMESTAMPTZ '2000-01-01') AS bucket, sweep_id, experiment, mode, comms_range,
       count(*) AS n, sum(burnt) AS burnt_sum, sum(burnt::float8 * burnt) AS burnt_sq_sum,
       sum(village_lost) AS village_lost_sum, sum(drones_lost) AS drones_lost_sum
FROM run_results GROUP BY 1, sweep_id, experiment, mode, comms_range;
-- ;;

-- ---------------------------------------------------------------- policies
-- Keep the aggregates materialised in the background (real-time aggregation covers the rest).
-- @timescale
SELECT add_continuous_aggregate_policy('fire_10s', start_offset => INTERVAL '1 day', end_offset => INTERVAL '1 minute', schedule_interval => INTERVAL '1 minute', if_not_exists => true);
-- ;;
-- @timescale
SELECT add_continuous_aggregate_policy('swarm_10s', start_offset => INTERVAL '1 day', end_offset => INTERVAL '1 minute', schedule_interval => INTERVAL '1 minute', if_not_exists => true);
-- ;;
-- @timescale
SELECT add_continuous_aggregate_policy('experiment_1h', start_offset => INTERVAL '7 days', end_offset => INTERVAL '1 hour', schedule_interval => INTERVAL '10 minutes', if_not_exists => true);
-- ;;

-- Columnstore (compression): CREATE TABLE ... WITH (tsdb.hypertable) already enables the
-- columnstore; these set when chunks are converted. Raw telemetry is bulky and only read
-- through the aggregates, so it moves to the columnstore after a day.
-- @timescale
CALL add_columnstore_policy('drone_telemetry', after => INTERVAL '1 day', if_not_exists => true);
-- ;;
-- @timescale
CALL add_columnstore_policy('fire_metrics', after => INTERVAL '1 day', if_not_exists => true);
-- ;;
-- @timescale
CALL add_columnstore_policy('events', after => INTERVAL '1 day', if_not_exists => true);
-- ;;
-- Raw drone telemetry is dropped after two weeks to stay inside the free tier; the aggregates keep the history.
-- @timescale
SELECT add_retention_policy('drone_telemetry', INTERVAL '14 days', if_not_exists => true);
