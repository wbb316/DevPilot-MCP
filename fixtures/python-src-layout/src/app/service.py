"""Service code behind the entry point."""

from __future__ import annotations


class Greeter:
    def __init__(self, name: str) -> None:
        self._name = name

    def greeting(self) -> str:
        return f"hello {self._name}"
