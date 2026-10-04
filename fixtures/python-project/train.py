"""Entry point for the fixture training loop."""

from data import load_batch
from model import GPT


def main(steps=3):
    model = GPT()
    for step in range(steps):
        inputs, _targets = load_batch()
        logits = model.forward(inputs)
        loss = model.loss(logits, [0.0 for _ in logits])
        print(f"step {step + 1}/{steps} loss {loss:.4f}")
    print("training done")


if __name__ == "__main__":
    main()
