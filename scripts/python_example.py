import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
STRUCTURE_PATH = ROOT / "assets" / "bedrock.mcstructure"


def run_node_json(command):
    completed = subprocess.run(
        command,
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(completed.stdout)


def main():
    parsed = run_node_json(
        [
            "node",
            "parse_mc_unified.js",
            str(STRUCTURE_PATH),
            "--target-version",
            "1.21.4",
            "--stdout",
            "--pretty",
        ]
    )

    print("target", parsed["meta"]["target"])
    print("block_count", parsed["meta"]["stats"]["blockCount"])
    print("unresolved_block_count", parsed["meta"]["stats"]["unresolvedBlockCount"])
    print("first_blocks", parsed["blocks"][:5])


if __name__ == "__main__":
    main()
