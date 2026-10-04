from app.service import Greeter


def test_greeting_uses_the_name() -> None:
    assert Greeter("x").greeting() == "hello x"
