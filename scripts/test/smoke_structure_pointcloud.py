#!/usr/bin/env python3

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT / "scripts"))

import sample_structure_pointcloud as pipeline


FIXTURE = PROJECT_ROOT / "assets" / "other" / "1.schem"


def run_cli(input_path, output_dir, expected_returncode=0):
    result = subprocess.run(
        [
            "python3",
            str(PROJECT_ROOT / "scripts" / "sample_structure_pointcloud.py"),
            str(input_path),
            "--version",
            "1.21.8",
            "--surface-points",
            "2048",
            "--points",
            "128",
            "--seed",
            "11",
            "--output-dir",
            str(output_dir),
        ],
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == expected_returncode, (
        f"point-cloud CLI returned {result.returncode}, expected {expected_returncode}\n"
        f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    )
    return result


def assert_npz_contract(path):
    with np.load(path) as payload:
        assert payload["surface_points_structure"].shape == (2048, 3)
        assert payload["fps_indices"].shape == (128,)
        assert payload["fps_points_structure"].shape == (128, 3)
        assert payload["fps_points_z_up"].shape == (128, 3)
        assert payload["points"].shape == (128, 3)
        assert np.isfinite(payload["points"]).all()
        assert np.allclose(payload["points"].mean(axis=0), 0.0, atol=1e-6)
        assert np.isclose(np.abs(payload["points"]).max(), 0.5, atol=1e-7)

        rotation = payload["structure_to_z_up_rotation"]
        inverse = payload["z_up_to_structure_rotation"]
        assert np.isclose(np.linalg.det(rotation), 1.0)
        assert np.allclose(rotation @ inverse, np.eye(3), atol=1e-12)

        reconstructed = (
            payload["points"].astype(np.float64) * float(payload["scale"])
            + payload["translation"]
        ) @ inverse.T
        assert np.allclose(
            reconstructed, payload["fps_points_structure"], atol=2e-6
        )
        return payload["points"].copy()


def assert_area_weighted_sampling():
    positions = np.asarray(
        [
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [10.0, 0.0, 0.0],
            [14.0, 0.0, 0.0],
            [10.0, 1.0, 0.0],
        ],
        dtype=np.float32,
    )
    indices = np.asarray([[0, 1, 2], [3, 4, 5]], dtype=np.uint32)
    points, stats = pipeline.sample_mesh_surface(
        positions, indices, 20_000, np.random.default_rng(5)
    )
    large_triangle_fraction = float(np.mean(points[:, 0] > 5.0))
    assert stats["positiveTriangleCount"] == 2
    assert np.isclose(stats["surfaceArea"], 2.5)
    assert 0.78 < large_triangle_fraction < 0.82, large_triangle_fraction


def main():
    assert FIXTURE.exists(), f"Missing fixture: {FIXTURE}"
    assert_area_weighted_sampling()

    with tempfile.TemporaryDirectory(prefix="pointcloud-smoke-") as temporary:
        root = Path(temporary)
        input_root = root / "inputs"
        first_input = input_root / "alpha" / "same.schem"
        second_input = input_root / "beta" / "same.schem"
        first_input.parent.mkdir(parents=True)
        second_input.parent.mkdir(parents=True)
        shutil.copy2(FIXTURE, first_input)
        shutil.copy2(FIXTURE, second_input)
        (input_root / "ignored.txt").write_text("ignored", encoding="utf-8")

        first_output = root / "output-a"
        second_output = root / "output-b"
        run_cli(input_root, first_output)
        run_cli(input_root, second_output)

        first_npz = (
            first_output
            / "alpha"
            / "same.schem.pointcloud"
            / "same.superdec.npz"
        )
        second_same_name_npz = (
            first_output
            / "beta"
            / "same.schem.pointcloud"
            / "same.superdec.npz"
        )
        repeated_npz = (
            second_output
            / "alpha"
            / "same.schem.pointcloud"
            / "same.superdec.npz"
        )
        assert first_npz.exists()
        assert second_same_name_npz.exists()
        first_points = assert_npz_contract(first_npz)
        repeated_points = assert_npz_contract(repeated_npz)
        assert np.array_equal(first_points, repeated_points)

        metadata_path = first_npz.with_suffix(".json")
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        assert metadata["outputCoordinateSpace"]["up"] == "+z"
        assert metadata["sampling"]["method"].endswith("exact_greedy_fps")
        assert metadata["mesh"]["counts"]["triangleCount"] > 0

        ply_path = first_npz.with_suffix(".ply")
        ply_header = ply_path.read_bytes().split(b"end_header\n", 1)[0]
        assert b"format binary_little_endian 1.0" in ply_header
        assert b"element vertex 128" in ply_header

        summary = json.loads(
            (first_output / "batch-summary.json").read_text(encoding="utf-8")
        )
        assert summary["counts"] == {
            "discovered": 2,
            "succeeded": 2,
            "failed": 0,
        }
        assert [item["input"] for item in summary["items"]] == [
            "alpha/same.schem",
            "beta/same.schem",
        ]

        partial_input = root / "partial-input"
        partial_input.mkdir()
        shutil.copy2(FIXTURE, partial_input / "good.schem")
        (partial_input / "invalid.nbt").write_bytes(b"not an nbt structure")
        partial_output = root / "partial-output"
        run_cli(partial_input, partial_output, expected_returncode=1)
        partial_summary = json.loads(
            (partial_output / "batch-summary.json").read_text(encoding="utf-8")
        )
        assert partial_summary["counts"] == {
            "discovered": 2,
            "succeeded": 1,
            "failed": 1,
        }
        assert (partial_output / "good.schem.pointcloud" / "good.superdec.ply").exists()
        assert not (
            partial_output / "invalid.nbt.pointcloud" / "invalid.superdec.ply"
        ).exists()

    print("Structure point-cloud smoke checks passed")


if __name__ == "__main__":
    main()
