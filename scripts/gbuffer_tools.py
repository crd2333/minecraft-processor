#!/usr/bin/env python3
"""Helpers for reading minecraft-processor GBuffer captures."""

import json
import math
from pathlib import Path

from PIL import Image


MAGIC = b"MCGBUF01"


def half_to_float(bits):
    sign = -1.0 if bits & 0x8000 else 1.0
    exponent = (bits >> 10) & 0x1F
    fraction = bits & 0x03FF

    if exponent == 0:
        if fraction == 0:
            return -0.0 if sign < 0 else 0.0
        return sign * (fraction / 1024.0) * (2 ** -14)
    if exponent == 0x1F:
        if fraction == 0:
            return -math.inf if sign < 0 else math.inf
        return math.nan
    return sign * (1.0 + fraction / 1024.0) * (2 ** (exponent - 15))


def load_gbuffer(path):
    path = Path(path)
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
    if meta_end > len(blob):
        raise ValueError("Invalid gbuffer: metadata length exceeds file size")

    metadata = json.loads(blob[meta_start:meta_end].decode("utf-8"))
    width = int(metadata["width"])
    height = int(metadata["height"])
    channels = metadata["channels"]
    data = memoryview(blob)[meta_end:]

    expected_pixels = width * height

    def channel_bytes(name, bytes_per_pixel):
        offset = int(channels[name]["offsetBytes"])
        size = expected_pixels * bytes_per_pixel
        end = offset + size
        if offset < 0 or end > len(data):
            raise ValueError(f"Invalid gbuffer: channel {name!r} exceeds data size")
        return bytes(data[offset:end])

    rgb_bytes = channel_bytes("rgb", 4)
    depth_bytes = channel_bytes("depth", 2)
    seg_bytes = channel_bytes("seg", 4)
    mask_bytes = channel_bytes("mask", 1)

    return {
        "version": version,
        "metadata": metadata,
        "width": width,
        "height": height,
        "rgb": Image.frombytes("RGBA", (width, height), rgb_bytes),
        "seg": Image.frombytes("RGBA", (width, height), seg_bytes),
        "mask": Image.frombytes("L", (width, height), mask_bytes),
        "depth_bytes": depth_bytes,
    }


def depth_values(depth_bytes):
    values = []
    for index in range(0, len(depth_bytes), 2):
        bits = int.from_bytes(depth_bytes[index:index + 2], "little")
        values.append(half_to_float(bits))
    return values


def depth_stats(depth_bytes):
    finite = [value for value in depth_values(depth_bytes) if math.isfinite(value) and value > 0]
    if not finite:
        return {"finiteCount": 0, "min": None, "max": None}
    return {
        "finiteCount": len(finite),
        "min": min(finite),
        "max": max(finite),
    }


def depth_visualization(depth_bytes, size):
    values = depth_values(depth_bytes)
    finite = [value for value in values if math.isfinite(value) and value > 0]
    if not finite:
        return Image.new("L", size, 0)

    dmin = min(finite)
    dmax = max(finite)
    scale = 255.0 / (dmax - dmin) if dmax > dmin else 0.0
    pixels = bytearray()
    for value in values:
        if not math.isfinite(value) or value <= 0:
            pixels.append(0)
        elif scale == 0.0:
            pixels.append(255)
        else:
            pixels.append(max(0, min(255, int(round((value - dmin) * scale)))))
    return Image.frombytes("L", size, bytes(pixels))


def save_gbuffer_debug_images(payload, out_dir):
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    width = int(payload["width"])
    height = int(payload["height"])
    size = (width, height)

    payload["rgb"].save(out_dir / "rgb.png")
    payload["seg"].save(out_dir / "seg.png")
    payload["mask"].point(lambda value: 255 if value > 0 else 0).save(out_dir / "mask.png")
    depth_visualization(payload["depth_bytes"], size).save(out_dir / "depth.png")
    (out_dir / "metadata.json").write_text(
        json.dumps(payload["metadata"], indent=2, sort_keys=True),
        encoding="utf-8",
    )

