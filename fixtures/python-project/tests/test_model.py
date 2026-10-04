import math

from data import load_batch
from model import CausalSelfAttention, GPT


def test_causal_attention_keeps_shape():
    attn = CausalSelfAttention(n_embd=4, block_size=3)
    x = [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0]]
    out = attn.forward(x)
    assert len(out) == 3
    assert all(len(row) == 4 for row in out)


def test_causal_mask_makes_softmax_rows_sum_to_one():
    attn = CausalSelfAttention(n_embd=2, block_size=2)
    x = [[1.0, 1.0], [2.0, 0.0]]
    scores = [[sum(a * b for a, b in zip(q, k)) * attn.scale for k in x] for q in x]
    row = scores[0]
    weights = attn._softmax(row)
    assert math.isclose(sum(weights), 1.0, rel_tol=1e-9)


def test_gpt_forward_and_loss_are_finite():
    model = GPT(vocab_size=32, n_embd=4, n_layer=2)
    inputs, _targets = load_batch(block_size=4, batch_size=2)
    logits = model.forward(inputs)
    assert len(logits) == 2
    loss = model.loss(logits, [0.0 for _ in logits])
    assert math.isfinite(loss) and loss >= 0.0
