# python-project fixture

A tiny torch-free training sketch: `model.py` holds `CausalSelfAttention` and
`GPT`, `data.py` yields fixed-shape batches, `train.py` runs a short loop.

Run it: `python train.py` (needs only the standard library).
Check imports: `python -c "import model, data, train"`.
