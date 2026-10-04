"""Fixture entry point: only importable as `python -m app.cli` with PYTHONPATH=src."""

from __future__ import annotations

from .service import Greeter


def main() -> None:
    greeter = Greeter("devpilot")
    print(f"greeting: {greeter.greeting()}")


if __name__ == "__main__":
    main()
