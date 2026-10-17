# Photo localization on the Vultr VM (proposal for Eric's review)

Branch `feature/place-match-vultr`. Arjun asked (2026-10-17) to run the MegaLoc engine
(`apps/place-match`) on the existing Vultr VM next to the Django API. Nothing has been
installed, resized or deployed; the deployment owner (Eric) decides. Background:
[deployment.md](deployment.md), [mobile-ios.md](mobile-ios.md),
[mobile-ios-api.md](mobile-ios-api.md), and the cloud alternative in
[place-match-production.md](place-match-production.md).

## Urgent first step: resize the VM (Eric)

The VM is 2 vCPU / 4 GB. MegaLoc alone needs about 2 GB of RAM and a full CPU core for
each frame. Running it next to Caddy and the API (two Gunicorn slots during each
release) leaves almost no memory headroom, and there is no swap.

**Please resize `snapway.work` (155.138.198.255) to at least 4 vCPU / 8 GB before we install
the engine** (16 GB if we later enable geometric verification or several reference sets):

1. Vultr dashboard › the server › **Snapshots**: take a snapshot first.
2. Server › **Settings › Change Plan**: pick a Regular/High Performance plan with ≥ 4 vCPU
   and ≥ 8 GB, same region (Atlanta). Check the monthly price shown there before
   confirming. Plans can be upgraded but not downgraded later.
3. Vultr restarts the VM: expect a few minutes of downtime for the website and API.
4. After it is back: `nproc`, `free -h`, `df -h /` show the new size;
   `https://snapway.work/api/health/ready/` returns 200; `sudo systemctl status caddy
   snapway-api-blue snapway-api-green` shows the active slot running.

No application change is needed for the resize itself.

## Measured and expected cost of MegaLoc on CPU

`apps/place-match/scripts/bench_cpu.py` (synthetic 322×322 frame, PyTorch CPU, no GPU):

| Machine | Threads | Median per frame | Model load | Peak RSS |
| --- | --- | --- | --- | --- |
| Arjun's MacBook Air (Apple M3) | 1 / 2 / 3 | 404 / 369 / 346 ms | 6.5 s | 1.91 GB |
| Vultr VM (x86 vCPU) | — | **not measured**; expect slower (roughly 0.8–1.6 s, estimate) | — | ≈ 2 GB |

Model: 229 M parameters, fp32, 0.91 GB weights. Geometric verification (SuperPoint +
LightGlue) adds ~1.1–1.3 s per frame on the M3 and more on the VM, so it stays off by
default. Throughput is about one frame per second per spare core: fine for a demo with a
few phones sending a frame per tap, not for many users streaming at 1 fps.

Run the benchmark on the VM after installation (step 4 below) and record the result here.

## What this branch adds

| File | Purpose |
| --- | --- |
| [`infra/install-place-match.sh`](../infra/install-place-match.sh) | Admin-run installer: `snapway-placematch` system user, `/srv/placematch/releases/<timestamp>` from reviewed source, locked `uv sync --frozen`, persistent `/srv/placematch/data`, systemd unit `snapway-placematch` |
| [`infra/placematch.env.example`](../infra/placematch.env.example) | `/etc/indoor-nav/placematch.env` template (token, reference set, Vertex off, frame storage off, thread count) |
| [`infra/api.env.example`](../infra/api.env.example) | `PLACEMATCH_ENGINE_URL`, `PLACEMATCH_ENGINE_TOKEN` for the API |
| [`apps/place-match/scripts/bench_cpu.py`](../apps/place-match/scripts/bench_cpu.py) | CPU latency/memory benchmark; sends nothing |

Design choices:

- **Separate from automatic releases.** The CI package still contains only `apps/api`,
  `apps/mcp` and `packages`; `infra/deploy.py` is unchanged. The engine is updated by an
  administrator rerunning the installer, so a normal merge cannot restart or break it.
- **Loopback only.** `serve-mobile` listens on `127.0.0.1:8790`; Caddy does not route to it.
  The phone reaches it only through the API's `/api/navigation/localize/` (auth + throttle).
- **The API stays up if the engine misbehaves.** `MemoryMax` (default 2600M on 4 GB,
  `PLACEMATCH_MEMORY_MAX=3500M` on 8 GB) makes the kernel kill the engine, not Gunicorn;
  `CPUWeight=50` and `Nice=5` give the API priority. The API then answers 503.
- **No new dependencies.** The engine's existing `uv.lock` is used as is. On Linux it
  installs the CUDA-enabled PyTorch wheels (several GB of disk, unused without a GPU);
  switching to CPU-only wheels would be a dependency change needing approval.
- **No Google credentials on the VM.** `MOBILE_ENABLE_VERTEX=0`: MegaLoc only.
- **No frame storage.** `MOBILE_STORE_FRAMES=0`; frames are processed in a private temp
  directory and discarded.

## Install steps (after the resize; Eric or another admin)

From a Mac/PC with the repository at the reviewed commit:

```sh
git archive --format=tar.gz -o place-match.tgz <commit> apps/place-match infra
scp place-match.tgz snapwayadmin@155.138.198.255:~/
```

On the server:

```bash
mkdir -p ~/snapway-placematch && tar -C ~/snapway-placematch -xzf ~/place-match.tgz
cd ~/snapway-placematch
sudo PLACEMATCH_MEMORY_MAX=3500M bash infra/install-place-match.sh
sudo nano /etc/indoor-nav/placematch.env   # MOBILE_API_TOKEN, MOBILE_REFERENCE_SET, OMP_NUM_THREADS=3
```

1. Weights (downloaded from the pinned official sources and checked by SHA-256):
   `sudo -u snapway-placematch /srv/placematch/current/.venv/bin/python -c "from placematch.backends import megaloc; megaloc.download()"`
2. Reference set, index and thresholds, built on Arjun's Mac and copied over (they
   are not in Git): `data/references/<set>/` and `data/calibration/current.json` →
   `/srv/placematch/data/` (owner `snapway-placematch`).
3. `sudo systemctl restart snapway-placematch` and `sudo journalctl -u snapway-placematch -n 50`.
4. Benchmark: `cd /srv/placematch/current && sudo -u snapway-placematch .venv/bin/python scripts/bench_cpu.py --threads 1 2 3`.
5. Health: `curl -s -H "Authorization: Bearer <token>" http://127.0.0.1:8790/v1/health`.
6. Add `PLACEMATCH_ENGINE_URL=http://127.0.0.1:8790` and `PLACEMATCH_ENGINE_TOKEN` to
   `/etc/indoor-nav/api.env`; the next API release (or a slot restart) picks them up.

Rollback: `sudo systemctl disable --now snapway-placematch` and clear
`PLACEMATCH_ENGINE_URL`; the API returns 503 `not_configured` again.

## Still open

- **Phone authentication in production.** With `DEBUG` off the dev token is rejected, and
  the iOS plugin does not carry a browser session. Production uploads need visitor
  `NavigationSession` issuance (model exists, endpoint not built).
- Not run on Linux: the installer, the systemd unit and the VM benchmark are untested.
- Thresholds were calibrated on dataset images; validate on iPhone frames first (§8 of
  the brief).
- MegaLoc/DINOv2 licence terms should be recorded before hosting (§6 of the brief).
