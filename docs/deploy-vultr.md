# Deploying HotDrones on Vultr

Two jobs for Vultr: **host the demo** (server + built app behind HTTPS) and **run the big
experiment sweeps** on a high-CPU instance, streaming into Tiger Data.

## 1. Host the demo (Vultr Cloud Compute)

1. Deploy a **Cloud Compute** instance: Ubuntu 24.04, any region near the judges (London),
   2 vCPU / 4 GB is plenty. The Marketplace "Docker" image saves a step; otherwise install Docker:
   `curl -fsSL https://get.docker.com | sh`.
2. In the Vultr firewall (or `ufw`), allow TCP 22, 80 and 443.
3. Point a DNS A record at the instance's IP (optional, but needed for HTTPS).
4. On the instance:

   ```bash
   git clone https://github.com/LB17GO/HotDrones.git && cd HotDrones
   cp .env.example .env && nano .env        # paste the keys you have; all are optional
   DOMAIN=hotdrones.example.com docker compose up -d --build
   ```

   Leave `DOMAIN` out to serve plain HTTP on port 80 (reach it by IP). With a domain, Caddy
   fetches and renews the certificate on its own. HTTPS matters for the demo: browsers only
   allow the microphone (push-to-talk commands) on HTTPS or localhost.
5. Check it: open the site, look at the status dots in the header, and `docker compose logs app`
   (the server prints one line per integration, on or off, and why).

Updating: `git pull && docker compose up -d --build`.

What lives where: scenarios go to MongoDB Atlas (or `/app/data/scenarios.json` in the
`hotdrones-data` volume if `MONGODB_URI` is not set); telemetry goes to Tiger Data; generated
speech is cached in the same volume.

## 2. Big experiment sweeps (high-CPU instance)

The sim is single-threaded, so a sweep scales with cores. `--workers N` runs it on N worker
threads; the CSV files are byte-identical to a single-threaded run.

1. Deploy an **Optimized Cloud Compute (CPU Optimized)** instance, e.g. 16 or 32 vCPU. Hourly
   billing: destroy it when the sweep has finished.
2. Same clone and `.env` as above (only `TIGER_DATABASE_URL` is needed).
3. Run it:

   ```bash
   SEEDS=300 WORKERS=16 docker compose run --rm sweep
   ```

   or without Docker: `npm ci && npm run experiment -- 300 --workers 16 --db`.

   That is 300 seeds × 25 conditions = 7,500 runs. A run takes roughly 0.2 s of one core, so
   expect a few minutes on 16 cores (measure on your instance; we have not run this size yet).
4. Watch `https://<your-site>/dashboard.html` while it runs: the experiment charts fill in
   from the `experiment_1h` continuous aggregate as runs land.

Database size: with `--db`, each run stores one `fire_metrics` row per 10 ticks and drone
telemetry every 50 ticks: about 50 + 120 rows for a typical run, so a 7,500-run sweep is on
the order of a million rows before the columnstore policy compresses them. If that is too
much for the free tier, lower the seed count: the comparison charts only need `run_results`
(one row per run).

## 3. Local equivalent

```bash
npm run build && npm start        # http://localhost:8787, same as the container
```
