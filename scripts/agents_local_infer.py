#!/usr/bin/env python3
"""
Local causal LM inference for My Cosmos Agents page.
Reads the full prompt from stdin; prints one JSON line to stdout:
  {"ok": true, "text": "...", "meta": {"model": "openai-community/gpt2"}}
or {"ok": false, "error": "..."}.

Matches story-geometry usage: HuggingFace ``openai-community/gpt2`` via AutoModelForCausalLM.
Override model id: MY_COSMOS_GPT2_MODEL; max new tokens: MY_COSMOS_GPT2_MAX_NEW (default 256).
"""
from __future__ import annotations

import json
import os
import sys


def main() -> None:
    mid = os.environ.get("MY_COSMOS_GPT2_MODEL", "openai-community/gpt2")
    prompt = sys.stdin.read()
    if not prompt.strip():
        print(json.dumps({"ok": False, "error": "empty prompt"}), flush=True)
        sys.exit(1)
    try:
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"Need torch and transformers: {e}"}), flush=True)
        sys.exit(1)

    try:
        mx = int(os.environ.get("MY_COSMOS_GPT2_MAX_NEW", "256"))
    except ValueError:
        mx = 256
    mx = max(8, min(mx, 512))

    device = "cuda" if torch.cuda.is_available() else "cpu"
    tok = AutoTokenizer.from_pretrained(mid, trust_remote_code=True)
    if tok.pad_token_id is None:
        tok.pad_token = tok.eos_token

    load_kw = {"trust_remote_code": True}
    try:
        model = AutoModelForCausalLM.from_pretrained(mid, torch_dtype=torch.float32, **load_kw)
    except TypeError:
        model = AutoModelForCausalLM.from_pretrained(mid, **load_kw)
    model.eval()
    model.to(device)

    inp = tok(prompt, return_tensors="pt").to(device)
    ctx = int(
        getattr(model.config, "n_positions", None)
        or getattr(model.config, "max_position_embeddings", None)
        or 1024
    )
    used = int(inp["input_ids"].shape[1])
    max_new = min(mx, max(8, ctx - used))

    with torch.no_grad():
        out = model.generate(
            **inp,
            max_new_tokens=max_new,
            do_sample=True,
            temperature=0.85,
            pad_token_id=tok.eos_token_id,
        )
    gen_ids = out[0][used:]
    text = tok.decode(gen_ids, skip_special_tokens=True)
    print(json.dumps({"ok": True, "text": text, "meta": {"model": mid}}), flush=True)


if __name__ == "__main__":
    main()
