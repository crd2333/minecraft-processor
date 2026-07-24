#!/usr/bin/env python3

import json
import shutil
import subprocess
import tempfile
from pathlib import Path

import numpy as np


PROJECT_ROOT = Path(__file__).resolve().parents[2]
FIXTURE = PROJECT_ROOT / "assets" / "other" / "1.schem"
SCRIPT = PROJECT_ROOT / "scripts" / "convert_structures_to_voxels.py"


def main():
    assert FIXTURE.exists(), f"Missing fixture: {FIXTURE}"

    with tempfile.TemporaryDirectory(prefix="structure-voxels-smoke-") as temporary:
        temporary_root = Path(temporary)
        input_dir = temporary_root / "structures"
        input_dir.mkdir()
        shutil.copy2(FIXTURE, input_dir / FIXTURE.name)
        output_dir = temporary_root / "voxels"
        result = subprocess.run(
            [
                "python3",
                str(SCRIPT),
                "--input-dir",
                str(input_dir),
                "--output-dir",
                str(output_dir),
            ],
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode == 0, (
            f"voxel conversion failed\nstdout:\n{result.stdout}\n"
            f"stderr:\n{result.stderr}"
        )

        output_path = output_dir / "1.npz"
        assert output_path.exists(), output_path
        with np.load(output_path) as payload:
            coordinates = payload["coordinates"]
            assert coordinates.dtype == np.int32
            assert coordinates.ndim == 2 and coordinates.shape[1] == 4
            assert np.array_equal(payload["xyz"], coordinates[:, :3])
            assert np.array_equal(payload["palette_ids"], coordinates[:, 3])

        summary = json.loads(
            (output_dir / "batch-summary.json").read_text(encoding="utf-8")
        )
        assert summary["counts"]["discovered"] == 1
        assert summary["counts"]["succeeded"] == 1
        assert summary["counts"]["failed"] == 0
        assert summary["counts"]["voxels"] == len(coordinates)

    print("Structure voxel conversion smoke checks passed")


if __name__ == "__main__":
    main()
