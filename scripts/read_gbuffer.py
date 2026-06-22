#!/usr/bin/env python3

import argparse
import json
from pathlib import Path

from gbuffer_tools import depth_stats, load_gbuffer, save_gbuffer_debug_images


def main():
    parser = argparse.ArgumentParser(description="Read minecraft gbuffer.bin")
    parser.add_argument("gbuffer", type=Path, help="Path to gbuffer.bin")
    parser.add_argument(
        "--out", type=Path, default=Path("gbuffer_out"), help="Output directory"
    )
    parser.add_argument(
        "--save", action="store_true", help="Save debug PNG outputs"
    )
    args = parser.parse_args()

    payload = load_gbuffer(args.gbuffer)
    meta = payload["metadata"]
    stats = depth_stats(payload["depth_bytes"])
    mask = payload["mask"]

    print("format:", meta.get("format"))
    print("resolution:", meta.get("width"), "x", meta.get("height"))
    print("segMode:", meta.get("segMode"))
    print(
        "camera near/far:",
        meta.get("camera", {}).get("near"),
        meta.get("camera", {}).get("far"),
    )
    print("rgb mode/size:", payload["rgb"].mode, payload["rgb"].size)
    print(
        "depth finite/min/max:",
        stats["finiteCount"],
        stats["min"],
        stats["max"],
    )
    print("seg mode/size:", payload["seg"].mode, payload["seg"].size)
    print("mask foreground pixels:", sum(1 for value in mask.getdata() if value > 0))

    if args.save:
        save_gbuffer_debug_images(payload, args.out)
        print(f"Wrote PNG debug images to: {args.out}")
        (args.out / "summary.json").write_text(
            json.dumps(
                {
                    "format": meta.get("format"),
                    "width": meta.get("width"),
                    "height": meta.get("height"),
                    "segMode": meta.get("segMode"),
                    "depth": stats,
                },
                indent=2,
                sort_keys=True,
            ),
            encoding="utf-8",
        )


if __name__ == "__main__":
    main()
