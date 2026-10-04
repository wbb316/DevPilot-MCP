"""Tiny synthetic text loader (no downloads, no tokenizer files)."""

CORPUS = "the quick brown fox jumps over the lazy dog again and again"
BLOCK_SIZE = 8


def load_batch(block_size=BLOCK_SIZE, batch_size=2):
    """Yield (inputs, targets) pairs of fixed shape from CORPUS."""
    ids = [ord(ch) for ch in CORPUS]
    xs, ys = [], []
    for i in range(batch_size):
        start = (i * block_size) % (len(ids) - block_size - 1)
        xs.append(ids[start:start + block_size])
        ys.append(ids[start + 1:start + block_size + 1])
    return xs, ys
