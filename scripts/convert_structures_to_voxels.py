#!/usr/bin/env python3

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

try:
    import numpy as np
except ModuleNotFoundError as error:
    raise SystemExit("NumPy is required to write voxel NPZ files.") from error


PROJECT_ROOT = Path(__file__).resolve().parents[1]
UNIFIED_PARSER = PROJECT_ROOT / "parse_mc_unified.js"
DEFAULT_INPUT = PROJECT_ROOT / "outputs" / "minecraft-dataset" / "structures"
DEFAULT_OUTPUT = PROJECT_ROOT / "outputs" / "voxels"
SUPPORTED_EXTENSIONS = {
    ".schem",
    ".schematic",
    ".litematic",
    ".nbt",
    ".mcstructure",
}


def discover_inputs(input_dir):
    input_dir = input_dir.resolve()
    if not input_dir.is_dir():
        raise ValueError(f"Input directory does not exist: {input_dir}")

    inputs = sorted(
        (
            path
            for path in input_dir.rglob("*")
            if path.is_file() and path.suffix.lower() in SUPPORTED_EXTENSIONS
        ),
        key=lambda path: path.relative_to(input_dir).as_posix(),
    )
    if not inputs:
        supported = ", ".join(sorted(SUPPORTED_EXTENSIONS))
        raise ValueError(
            f"No supported structure files found under {input_dir}; "
            f"expected one of: {supported}"
        )
    return input_dir, inputs


def output_path_for(input_path, input_root, output_root):
    relative_path = input_path.relative_to(input_root)
    return (output_root / relative_path).with_suffix(".npz")


def check_output_collisions(inputs, input_root, output_root):
    claimed = {}
    for input_path in inputs:
        output_path = output_path_for(input_path, input_root, output_root)
        previous = claimed.setdefault(output_path, input_path)
        if previous != input_path:
            raise ValueError(
                f"Output collision: {previous} and {input_path} both map to "
                f"{output_path}"
            )


def run_node_json(input_path, target_version=None):
    command = [
        "node",
        str(UNIFIED_PARSER),
        str(input_path),
        "--stdout",
    ]
    if target_version:
        command.extend(["--target-version", target_version])

    completed = subprocess.run(
        command,
        cwd=PROJECT_ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        details = completed.stderr.strip() or completed.stdout.strip()
        raise RuntimeError(details or "parse_mc_unified.js failed without output")

    try:
        return json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(
            f"parse_mc_unified.js returned invalid JSON: {error}"
        ) from error


def parse_coordinates(input_path, target_version=None):
    parsed = run_node_json(input_path, target_version=target_version)
    coordinates = np.asarray(parsed.get("blocks"), dtype=np.int32)
    if coordinates.ndim != 2 or coordinates.shape[1] != 4:
        raise ValueError(
            f"Unified blocks must have shape (N, 4), got {coordinates.shape}"
        )
    return coordinates


def write_npz_atomic(output_path, coordinates):
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="wb",
        prefix=f".{output_path.stem}.",
        suffix=".npz.tmp",
        dir=output_path.parent,
        delete=False,
    ) as temporary:
        temporary_path = Path(temporary.name)
        try:
            np.savez_compressed(
                temporary,
                coordinates=coordinates,
                xyz=coordinates[:, :3],
                palette_ids=coordinates[:, 3],
            )
        except Exception:
            temporary_path.unlink(missing_ok=True)
            raise

    os.replace(temporary_path, output_path)


def write_summary(output_root, payload):
    output_root.mkdir(parents=True, exist_ok=True)
    summary_path = output_root / "batch-summary.json"
    temporary_path = summary_path.with_name(f".{summary_path.name}.tmp")
    temporary_path.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary_path, summary_path)


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description=(
            "Batch-convert unified Minecraft structure blocks into compressed "
            "int32 NPZ arrays."
        )
    )
    parser.add_argument(
        "--input-dir",
        type=Path,
        default=DEFAULT_INPUT,
        help=f"Structure directory (default: {DEFAULT_INPUT})",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_OUTPUT,
        help=f"NPZ output directory (default: {DEFAULT_OUTPUT})",
    )
    parser.add_argument(
        "--target-version",
        help="Optional canonical Java target version passed to the unified parser",
    )
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    input_root, inputs = discover_inputs(args.input_dir)
    output_root = args.output_dir.resolve()
    check_output_collisions(inputs, input_root, output_root)

    print(f"Discovered {len(inputs)} structure file(s) under {input_root}")
    started = time.perf_counter()
    succeeded = []
    failed = []

    for index, input_path in enumerate(inputs, start=1):
        relative_path = input_path.relative_to(input_root)
        output_path = output_path_for(input_path, input_root, output_root)
        print(f"[{index}/{len(inputs)}] Converting {relative_path.as_posix()}")
        try:
            coordinates = parse_coordinates(
                input_path,
                target_version=args.target_version,
            )
            write_npz_atomic(output_path, coordinates)
            succeeded.append(
                {
                    "input": relative_path.as_posix(),
                    "output": output_path.relative_to(output_root).as_posix(),
                    "voxelCount": int(coordinates.shape[0]),
                }
            )
        except Exception as error:
            failed.append(
                {
                    "input": relative_path.as_posix(),
                    "error": str(error),
                }
            )
            print(f"  Failed: {error}", file=sys.stderr)

    summary = {
        "schemaVersion": 1,
        "inputRoot": str(input_root),
        "outputRoot": str(output_root),
        "targetVersion": args.target_version,
        "arrays": {
            "coordinates": "int32 [x, y, z, palette_id]",
            "xyz": "int32 [x, y, z]",
            "palette_ids": "int32 palette_id",
        },
        "counts": {
            "discovered": len(inputs),
            "succeeded": len(succeeded),
            "failed": len(failed),
            "voxels": sum(item["voxelCount"] for item in succeeded),
        },
        "elapsedSeconds": round(time.perf_counter() - started, 6),
        "items": succeeded,
        "failures": failed,
    }
    write_summary(output_root, summary)

    print(
        f"Wrote {len(succeeded)} NPZ file(s) with "
        f"{summary['counts']['voxels']} voxels to {output_root}"
    )
    if failed:
        print(
            f"{len(failed)} structure(s) failed; see "
            f"{output_root / 'batch-summary.json'}",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
