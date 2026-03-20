import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
STRUCTURE_PATH = ROOT / "assets" / "bedrock.mcstructure"
VOCAB_PATH = ROOT / "generated" / "block-vocab.1.21.4.json"


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
    vocabulary = json.loads(VOCAB_PATH.read_text(encoding="utf-8"))

    parsed = run_node_json([
        "node",
        "parse_mc_ids.js",
        str(STRUCTURE_PATH),
        str(VOCAB_PATH),
        "--entity-only",
        "--stdout",
        "--pretty",
    ])

    print("vocab_entity_range", vocabulary["ranges"]["entity"])
    print("block_count", parsed["meta"]["outputBlockCount"])
    print("unknown_block_count", parsed["meta"]["unknownBlockCount"])
    print("first_blocks", parsed["blocks"][:5])


if __name__ == "__main__":
    main()