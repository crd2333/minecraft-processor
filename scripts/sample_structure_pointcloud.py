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
    raise SystemExit(
        "NumPy is required. Install it with "
        '"python3 -m pip install -r requirements-pointcloud.txt".'
    ) from error


PROJECT_ROOT = Path(__file__).resolve().parents[1]
NODE_MESH_BRIDGE = PROJECT_ROOT / "scripts" / "export_structure_mesh.js"
DEFAULT_VERSION = "1.21.8"
DEFAULT_SURFACE_POINTS = 100_000
DEFAULT_FINAL_POINTS = 4_096
DEFAULT_SEED = 0
SUPPORTED_EXTENSIONS = {
    ".schem",
    ".schematic",
    ".litematic",
    ".nbt",
    ".mcstructure",
}
STRUCTURE_TO_Z_UP = np.asarray(
    [
        [1.0, 0.0, 0.0],
        [0.0, 0.0, -1.0],
        [0.0, 1.0, 0.0],
    ],
    dtype=np.float64,
)


def positive_int(value):
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("expected a positive integer")
    return parsed


def discover_inputs(input_path):
    resolved = input_path.resolve()
    if resolved.is_file():
        if resolved.suffix.lower() not in SUPPORTED_EXTENSIONS:
            supported = ", ".join(sorted(SUPPORTED_EXTENSIONS))
            raise ValueError(
                f"Unsupported structure extension {resolved.suffix or '(none)'}; "
                f"expected one of: {supported}"
            )
        return resolved.parent, [(resolved, Path(resolved.name))], False

    if resolved.is_dir():
        files = [
            path
            for path in resolved.rglob("*")
            if path.is_file() and path.suffix.lower() in SUPPORTED_EXTENSIONS
        ]
        files.sort(key=lambda path: path.relative_to(resolved).as_posix())
        if not files:
            raise ValueError(f"No supported structure files found under: {resolved}")
        return resolved, [(path, path.relative_to(resolved)) for path in files], True

    raise ValueError(f"Input path does not exist: {resolved}")


def default_output_dir(input_path):
    return PROJECT_ROOT / "outputs" / "pointcloud" / input_path.name


def item_output_dir(output_root, relative_path, directory_mode):
    if not directory_mode:
        return output_root
    return output_root / relative_path.parent / f"{relative_path.name}.pointcloud"


def run_mesh_bridge(input_path, output_dir, version):
    command = [
        "node",
        str(NODE_MESH_BRIDGE),
        str(input_path),
        "--version",
        version,
        "--output-dir",
        str(output_dir),
    ]
    result = subprocess.run(
        command,
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        details = result.stderr.strip() or result.stdout.strip() or "unknown Node.js error"
        raise RuntimeError(f"JavaScript mesh extraction failed: {details}")


def load_mesh(mesh_dir):
    metadata_path = mesh_dir / "mesh.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    counts = metadata.get("counts", {})
    buffers = metadata.get("buffers", {})
    vertex_count = int(counts.get("vertexCount", 0))
    index_count = int(counts.get("indexCount", 0))

    if vertex_count <= 0:
        raise ValueError("Mesh metadata reports no vertices")
    if index_count <= 0 or index_count % 3:
        raise ValueError(f"Mesh metadata has invalid index count: {index_count}")

    positions_path = mesh_dir / buffers.get("positions", "positions.f32")
    indices_path = mesh_dir / buffers.get("indices", "indices.u32")
    positions = np.fromfile(positions_path, dtype="<f4")
    indices = np.fromfile(indices_path, dtype="<u4")

    if positions.size != vertex_count * 3:
        raise ValueError(
            f"Position buffer contains {positions.size} scalars; expected {vertex_count * 3}"
        )
    if indices.size != index_count:
        raise ValueError(
            f"Index buffer contains {indices.size} values; expected {index_count}"
        )

    positions = positions.reshape(vertex_count, 3)
    indices = indices.reshape(-1, 3)
    if not np.isfinite(positions).all():
        raise ValueError("Mesh position buffer contains non-finite coordinates")
    if int(indices.max()) >= vertex_count:
        raise ValueError(
            f"Mesh index {int(indices.max())} exceeds vertex count {vertex_count}"
        )
    return positions, indices, metadata


def sample_mesh_surface(positions, indices, count, rng):
    triangles = positions[indices]
    edges_a = triangles[:, 1] - triangles[:, 0]
    edges_b = triangles[:, 2] - triangles[:, 0]
    double_areas = np.linalg.norm(np.cross(edges_a, edges_b), axis=1).astype(
        np.float64
    )
    valid = np.isfinite(double_areas) & (double_areas > 0.0)
    if not np.any(valid):
        raise ValueError("Generated mesh has no positive-area triangles")

    triangles = triangles[valid]
    double_areas = double_areas[valid]
    cumulative_areas = np.cumsum(double_areas, dtype=np.float64)
    total_double_area = float(cumulative_areas[-1])
    selected = np.searchsorted(
        cumulative_areas,
        rng.random(count) * total_double_area,
        side="right",
    )
    chosen = triangles[selected]

    root_u = np.sqrt(rng.random(count))
    v = rng.random(count)
    weight_a = 1.0 - root_u
    weight_b = root_u * (1.0 - v)
    weight_c = root_u * v
    points = (
        chosen[:, 0] * weight_a[:, None]
        + chosen[:, 1] * weight_b[:, None]
        + chosen[:, 2] * weight_c[:, None]
    )
    return points.astype(np.float32), {
        "positiveTriangleCount": int(valid.sum()),
        "surfaceArea": total_double_area / 2.0,
    }


def farthest_point_sample(points, count, rng):
    if points.ndim != 2 or points.shape[1] != 3:
        raise ValueError(f"FPS expects an (N, 3) point array, got {points.shape}")
    if count > len(points):
        raise ValueError(
            f"FPS point count {count} exceeds surface sample count {len(points)}"
        )

    selected = np.empty(count, dtype=np.int64)
    min_distances = np.full(len(points), np.inf, dtype=np.float32)
    scratch = np.empty_like(points)
    squared_distances = np.empty(len(points), dtype=np.float32)
    current = int(rng.integers(len(points)))

    for index in range(count):
        selected[index] = current
        np.subtract(points, points[current], out=scratch)
        np.square(scratch, out=scratch)
        np.sum(scratch, axis=1, out=squared_distances)
        np.minimum(min_distances, squared_distances, out=min_distances)
        current = int(np.argmax(min_distances))

    return selected


def rotate_and_normalize(points_structure):
    points_z_up = points_structure.astype(np.float64) @ STRUCTURE_TO_Z_UP.T
    translation = points_z_up.mean(axis=0)
    centered = points_z_up - translation
    scale = 2.0 * float(np.max(np.abs(centered)))
    if not np.isfinite(scale) or scale <= 0.0:
        raise ValueError(f"Cannot normalize a degenerate point cloud with scale {scale}")
    normalized = (centered / scale).astype(np.float32)
    return points_z_up.astype(np.float32), normalized, translation, scale


def write_binary_ply(path, points):
    header = "\n".join(
        [
            "ply",
            "format binary_little_endian 1.0",
            "comment normalized z-up SuperDec input generated by minecraft-processor",
            f"element vertex {len(points)}",
            "property float x",
            "property float y",
            "property float z",
            "end_header",
            "",
        ]
    ).encode("ascii")
    with path.open("wb") as output:
        output.write(header)
        output.write(np.ascontiguousarray(points, dtype="<f4").tobytes())


def write_json_atomic(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    os.replace(temporary, path)


def artifact_paths(output_dir, input_path):
    stem = input_path.stem
    return {
        "ply": output_dir / f"{stem}.superdec.ply",
        "npz": output_dir / f"{stem}.superdec.npz",
        "metadata": output_dir / f"{stem}.superdec.json",
    }


def make_item_metadata(
    input_path,
    relative_path,
    version,
    seed,
    surface_count,
    final_count,
    mesh_metadata,
    sampling_stats,
    translation,
    scale,
    artifacts,
    elapsed_seconds,
):
    rotation = STRUCTURE_TO_Z_UP.tolist()
    inverse_rotation = STRUCTURE_TO_Z_UP.T.tolist()
    return {
        "schemaVersion": 1,
        "source": {
            "path": str(input_path.resolve()),
            "relativePath": relative_path.as_posix(),
            "format": mesh_metadata["source"]["format"],
            "sourceVersion": mesh_metadata["source"].get("version"),
            "targetVersion": version,
        },
        "sampling": {
            "method": "triangle_area_uniform_then_exact_greedy_fps",
            "seed": seed,
            "surfacePointCount": surface_count,
            "finalPointCount": final_count,
            **sampling_stats,
        },
        "mesh": {
            "coordinateSpace": mesh_metadata["coordinateSpace"],
            "structureSize": mesh_metadata["structureSize"],
            "counts": mesh_metadata["counts"],
            "bounds": mesh_metadata["bounds"],
        },
        "outputCoordinateSpace": {
            "axes": ["x", "y", "z"],
            "up": "+z",
            "units": "normalized",
            "rightHanded": True,
        },
        "transform": {
            "structureToZUpRotation": rotation,
            "zUpToStructureRotation": inverse_rotation,
            "translationZUp": translation.tolist(),
            "scale": scale,
            "forward": "normalized = (R * structure_point - translation) / scale",
            "inverse": "structure_point = transpose(R) * (normalized * scale + translation)",
        },
        "artifacts": {name: str(path.resolve()) for name, path in artifacts.items()},
        "elapsedSeconds": elapsed_seconds,
    }


def process_item(
    input_path,
    relative_path,
    output_dir,
    version,
    surface_count,
    final_count,
    seed,
):
    started = time.perf_counter()
    output_dir.mkdir(parents=True, exist_ok=True)
    artifacts = artifact_paths(output_dir, input_path)
    rng = np.random.default_rng(seed)

    with tempfile.TemporaryDirectory(prefix="minecraft-mesh-") as temporary:
        mesh_dir = Path(temporary)
        run_mesh_bridge(input_path, mesh_dir, version)
        positions, indices, mesh_metadata = load_mesh(mesh_dir)

    surface_points, sampling_stats = sample_mesh_surface(
        positions, indices, surface_count, rng
    )
    fps_indices = farthest_point_sample(surface_points, final_count, rng)
    fps_points_structure = surface_points[fps_indices]
    fps_points_z_up, normalized_points, translation, scale = rotate_and_normalize(
        fps_points_structure
    )

    with tempfile.TemporaryDirectory(
        prefix=f".{input_path.stem}.pointcloud-", dir=output_dir
    ) as temporary:
        staging = Path(temporary)
        staged = artifact_paths(staging, input_path)
        write_binary_ply(staged["ply"], normalized_points)
        np.savez_compressed(
            staged["npz"],
            surface_points_structure=surface_points,
            fps_indices=fps_indices,
            fps_points_structure=fps_points_structure,
            fps_points_z_up=fps_points_z_up,
            points=normalized_points,
            translation=translation,
            scale=np.asarray(scale, dtype=np.float64),
            structure_to_z_up_rotation=STRUCTURE_TO_Z_UP,
            z_up_to_structure_rotation=STRUCTURE_TO_Z_UP.T,
        )
        metadata = make_item_metadata(
            input_path=input_path,
            relative_path=relative_path,
            version=version,
            seed=seed,
            surface_count=surface_count,
            final_count=final_count,
            mesh_metadata=mesh_metadata,
            sampling_stats=sampling_stats,
            translation=translation,
            scale=scale,
            artifacts=artifacts,
            elapsed_seconds=round(time.perf_counter() - started, 6),
        )
        staged["metadata"].write_text(
            json.dumps(metadata, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        for name in ("ply", "npz", "metadata"):
            os.replace(staged[name], artifacts[name])

    return metadata


def remove_item_artifacts(output_dir, input_path):
    for artifact in artifact_paths(output_dir, input_path).values():
        try:
            artifact.unlink()
        except FileNotFoundError:
            pass


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description=(
            "Convert one Minecraft structure or a directory of structures into "
            "normalized z-up SuperDec point clouds."
        )
    )
    parser.add_argument("input", type=Path, help="Structure file or directory")
    parser.add_argument(
        "--output-dir",
        type=Path,
        help="Output root (default: outputs/pointcloud/<input-name>)",
    )
    parser.add_argument(
        "--version", default=DEFAULT_VERSION, help="Minecraft target version"
    )
    parser.add_argument(
        "--surface-points",
        type=positive_int,
        default=DEFAULT_SURFACE_POINTS,
        help=(
            "Area-uniform surface samples before FPS "
            f"(default: {DEFAULT_SURFACE_POINTS})"
        ),
    )
    parser.add_argument(
        "--points",
        type=positive_int,
        default=DEFAULT_FINAL_POINTS,
        help=f"Final exact-FPS point count (default: {DEFAULT_FINAL_POINTS})",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=DEFAULT_SEED,
        help=f"Random seed (default: {DEFAULT_SEED})",
    )
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    if args.points > args.surface_points:
        raise ValueError(
            f"--points ({args.points}) cannot exceed --surface-points ({args.surface_points})"
        )

    source_root, items, directory_mode = discover_inputs(args.input)
    output_root = (args.output_dir or default_output_dir(args.input.resolve())).resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    summary_items = []
    failures = 0
    batch_started = time.perf_counter()

    print(f"Discovered {len(items)} structure file(s) under {source_root}")
    for index, (input_path, relative_path) in enumerate(items, start=1):
        output_dir = item_output_dir(output_root, relative_path, directory_mode)
        print(f"[{index}/{len(items)}] Sampling {relative_path.as_posix()}")
        try:
            metadata = process_item(
                input_path=input_path,
                relative_path=relative_path,
                output_dir=output_dir,
                version=args.version,
                surface_count=args.surface_points,
                final_count=args.points,
                seed=args.seed,
            )
            summary_items.append(
                {
                    "input": relative_path.as_posix(),
                    "status": "ok",
                    "outputDirectory": str(output_dir.resolve()),
                    "metadata": metadata["artifacts"]["metadata"],
                    "elapsedSeconds": metadata["elapsedSeconds"],
                }
            )
            print(
                f"  Wrote {args.points} points to "
                f"{metadata['artifacts']['ply']} ({metadata['elapsedSeconds']:.2f}s)"
            )
        except Exception as error:
            failures += 1
            remove_item_artifacts(output_dir, input_path)
            summary_items.append(
                {
                    "input": relative_path.as_posix(),
                    "status": "error",
                    "outputDirectory": str(output_dir.resolve()),
                    "error": str(error),
                }
            )
            print(f"  Failed: {error}", file=sys.stderr)

    summary = {
        "schemaVersion": 1,
        "input": str(args.input.resolve()),
        "inputMode": "directory" if directory_mode else "file",
        "outputRoot": str(output_root),
        "parameters": {
            "version": args.version,
            "surfacePointCount": args.surface_points,
            "finalPointCount": args.points,
            "seed": args.seed,
            "coordinateSystem": "right_handed_z_up",
        },
        "counts": {
            "discovered": len(items),
            "succeeded": len(items) - failures,
            "failed": failures,
        },
        "elapsedSeconds": round(time.perf_counter() - batch_started, 6),
        "items": summary_items,
    }
    summary_path = output_root / "batch-summary.json"
    write_json_atomic(summary_path, summary)
    print(f"Batch summary: {summary_path}")
    return 1 if failures else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, OSError) as error:
        print(f"Error: {error}", file=sys.stderr)
        raise SystemExit(1)
