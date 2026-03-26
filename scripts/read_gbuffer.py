#!/usr/bin/env python3

import argparse
import json
from pathlib import Path

import numpy as np


MAGIC = b"MCGBUF01"


def load_gbuffer(path: Path):
    blob = path.read_bytes()
    if len(blob) < 16:
        raise ValueError("Invalid gbuffer: file too small")

    magic = blob[:8]
    if magic != MAGIC:
        raise ValueError(f"Invalid magic: {magic!r}")

    version = int.from_bytes(blob[8:12], "little")
    meta_len = int.from_bytes(blob[12:16], "little")
    meta_start = 16
    meta_end = meta_start + meta_len
    metadata = json.loads(blob[meta_start:meta_end].decode("utf-8"))

    w = int(metadata["width"])
    h = int(metadata["height"])

    data = memoryview(blob)[meta_end:]
    ch = metadata["channels"]

    rgb = np.frombuffer(
        data[ch["rgb"]["offsetBytes"] :], dtype=np.uint8, count=w * h * 4
    ).reshape(h, w, 4)
    depth = np.frombuffer(
        data[ch["depth"]["offsetBytes"] :], dtype=np.float16, count=w * h
    ).reshape(h, w)
    seg = np.frombuffer(
        data[ch["seg"]["offsetBytes"] :], dtype=np.uint8, count=w * h * 4
    ).reshape(h, w, 4)
    mask = np.frombuffer(
        data[ch["mask"]["offsetBytes"] :], dtype=np.uint8, count=w * h
    ).reshape(h, w)

    # Depth is already metric z in float16 (background is +Inf)
    z = depth.astype(np.float32)

    return {
        "version": version,
        "metadata": metadata,
        "rgb": rgb,
        "depth": depth,
        "depth_metric": z,
        "seg": seg,
        "mask": mask,
    }


def save_debug_images(out_dir: Path, payload: dict):
    out_dir.mkdir(parents=True, exist_ok=True)

    rgb = payload["rgb"]
    seg = payload["seg"]
    mask = payload["mask"]
    depth = payload["depth"].astype(np.float32)
    finite = np.isfinite(depth) & (depth > 0)
    depth_vis = np.zeros_like(depth, dtype=np.float32)
    if np.any(finite):
        dmin = float(np.min(depth[finite]))
        dmax = float(np.max(depth[finite]))
        if dmax > dmin:
            depth_vis[finite] = (depth[finite] - dmin) / (dmax - dmin)
        else:
            depth_vis[finite] = 1.0
    depth_vis = np.clip(depth_vis * 255.0, 0, 255).astype(np.uint8)

    # Headless-friendly: save PNG files if imageio is available.
    try:
        import imageio.v2 as iio  # type: ignore

        iio.imwrite(out_dir / "rgb.png", rgb)
        iio.imwrite(out_dir / "seg.png", seg)
        iio.imwrite(out_dir / "mask.png", mask * 255)
        iio.imwrite(out_dir / "depth.png", depth_vis)
        print(f"Wrote PNG debug images to: {out_dir}")
    except Exception as exc:
        print(f"imageio not available ({exc}), saving .npy arrays instead")

    np.save(out_dir / "rgb.npy", rgb)
    np.save(out_dir / "seg.npy", seg)
    np.save(out_dir / "mask.npy", mask)
    np.save(out_dir / "depth.npy", payload["depth"])
    np.save(out_dir / "depth_metric.npy", payload["depth_metric"])
    (out_dir / "metadata.json").write_text(
        json.dumps(payload["metadata"], indent=2), encoding="utf-8"
    )


def main():
    parser = argparse.ArgumentParser(description="Read minecraft gbuffer.bin")
    parser.add_argument("gbuffer", type=Path, help="Path to gbuffer.bin")
    parser.add_argument(
        "--out", type=Path, default=Path("gbuffer_out"), help="Output directory"
    )
    parser.add_argument(
        "--save", action="store_true", help="Save debug outputs (PNG if possible + NPY)"
    )
    args = parser.parse_args()

    payload = load_gbuffer(args.gbuffer)
    meta = payload["metadata"]

    print("format:", meta.get("format"))
    print("resolution:", meta.get("width"), "x", meta.get("height"))
    print("segMode:", meta.get("segMode"))
    print(
        "camera near/far:",
        meta.get("camera", {}).get("near"),
        meta.get("camera", {}).get("far"),
    )
    print("rgb shape:", payload["rgb"].shape, payload["rgb"].dtype)
    print(
        "depth shape:",
        payload["depth"].shape,
        payload["depth"].dtype,
        "min/max:",
        float(np.nanmin(payload["depth"])),
        float(np.nanmax(payload["depth"])),
    )
    finite_depth = payload["depth_metric"][np.isfinite(payload["depth_metric"])]
    if finite_depth.size > 0:
        print(
            "depth_metric min/max:",
            float(np.min(finite_depth)),
            float(np.max(finite_depth)),
        )
    print("seg shape:", payload["seg"].shape, payload["seg"].dtype)
    print("mask foreground pixels:", int(np.sum(payload["mask"] > 0)))

    if args.save:
        save_debug_images(args.out, payload)


if __name__ == "__main__":
    main()
