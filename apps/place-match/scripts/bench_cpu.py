"""MegaLoc on CPU: model load time, per-frame latency and peak memory. Sends nothing.

Run on the target machine, after the weights are present:
    .venv/bin/python scripts/bench_cpu.py --threads 1 2
"""

from __future__ import annotations

import argparse
import platform
import resource
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def peak_rss_gb() -> float:
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return peak / 2**30 if sys.platform == "darwin" else peak / 2**20  # bytes vs KiB


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--threads", type=int, nargs="+", default=[1, 2])
    parser.add_argument("--frames", type=int, default=10)
    args = parser.parse_args()

    import torch

    from placematch.backends import megaloc

    megaloc.device_name = lambda: "cpu"
    torch.set_num_interop_threads(1)
    t0 = time.perf_counter()
    model = megaloc.load_model()
    print(f"{platform.machine()} {platform.processor() or ''} torch {torch.__version__}")
    print(f"load {time.perf_counter() - t0:.1f} s, peak RSS {peak_rss_gb():.2f} GB")

    frame = torch.rand(1, 3, 322, 322)
    for threads in args.threads:
        torch.set_num_threads(threads)
        times = []
        with torch.inference_mode():
            for _ in range(args.frames + 2):
                start = time.perf_counter()
                model(frame)
                times.append(time.perf_counter() - start)
        times = sorted(times[2:])  # drop warm-up
        print(
            f"threads={threads}: median {times[len(times) // 2] * 1000:.0f} ms, "
            f"max {times[-1] * 1000:.0f} ms, peak RSS {peak_rss_gb():.2f} GB"
        )


if __name__ == "__main__":
    main()
