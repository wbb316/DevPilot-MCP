"""Minimal attention + GPT sketch.

Deliberately torch-free so the fixture imports anywhere; a real project
would build the same shapes with `torch` tensors and `torch.nn.Module`.
"""

import math

N_EMBD = 16
N_HEAD = 4
BLOCK_SIZE = 8


class CausalSelfAttention:
    """Single-head causal self-attention over plain Python lists."""

    def __init__(self, n_embd=N_EMBD, block_size=BLOCK_SIZE):
        self.n_embd = n_embd
        self.block_size = block_size
        self.scale = 1.0 / math.sqrt(n_embd)

    def forward(self, x):
        """x: list of T rows of length n_embd -> same shape."""
        scores = [
            [sum(a * b for a, b in zip(q, k)) * self.scale for k in x]
            for q in x
        ]
        mask = [[0.0 if j <= i else float("-inf")
                 for j in range(len(x))] for i in range(len(x))]
        scores = [[s + m for s, m in zip(row, mrow)]
                  for row, mrow in zip(scores, mask)]
        weights = [self._softmax(row) for row in scores]
        return [self._mix(row, x) for row in weights]

    @staticmethod
    def _softmax(row):
        top = max(row)
        exps = [math.exp(v - top) for v in row]
        total = sum(exps)
        return [v / total for v in exps]

    @staticmethod
    def _mix(weights, x):
        return [sum(w * v for w, v in zip(weights, vec)) for vec in zip(*x)]


class GPT:
    """Stack of self-attention blocks with trivial residual updates."""

    def __init__(self, vocab_size=32, n_embd=N_EMBD, n_layer=2):
        self.vocab_size = vocab_size
        self.n_embd = n_embd
        self.blocks = [CausalSelfAttention(n_embd) for _ in range(n_layer)]

    def forward(self, idx):
        x = [[float(i) for i in row] for row in idx]
        for block in self.blocks:
            x = block.forward(x)
        return x

    def loss(self, logits, targets):
        """Mean squared error between each row mean and its scalar target."""
        total = 0.0
        for row, target in zip(logits, targets):
            mean = sum(row) / len(row)
            total += (mean - float(target)) ** 2
        return total / max(len(logits), 1)
