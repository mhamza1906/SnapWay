from pathlib import Path

import environ

ROOT = Path(__file__).resolve().parents[3]
env = environ.Env()
