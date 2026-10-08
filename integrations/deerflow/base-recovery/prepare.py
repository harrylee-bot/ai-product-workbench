#!/usr/bin/env python3
"""Produce a verified, local OCI base without changing running applications."""

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import uuid


def command(args, **kwargs):
    return subprocess.run(args, check=True, text=True, capture_output=True, **kwargs).stdout.strip()


def assert_image_configuration(original, recovered):
    for key in ["Entrypoint", "Cmd", "User", "Env", "WorkingDir"]:
        before, after = original.get(key), recovered.get(key)
        if key in ["Entrypoint", "Cmd"]:
            before, after = before or [], after or []
        if after != before:
            raise ValueError("RECOVERY_IMAGE_CONFIGURATION_DRIFT: " + key)


def prepare(candidate_root, output):
    output.mkdir(parents=True, mode=0o700, exist_ok=False)
    recovery = Path(__file__).resolve().parent
    policy_bytes = (recovery / "manifest.json").read_bytes()
    policy = json.loads(policy_bytes)
    source = policy["sourceImageId"]
    metadata = json.loads(command(["docker", "image", "inspect", source]))[0]
    if metadata["Id"] != source:
        raise ValueError("RECOVERY_IMAGE_ID_MISMATCH")
    if metadata["Config"].get("Entrypoint"):
        raise ValueError("RECOVERY_SOURCE_ENTRYPOINT_UNSUPPORTED")
    candidate_patch = candidate_root / "integrations/deerflow/source-patches" / policy["upstreamCommit"]
    name = "workbench-base-recovery-" + uuid.uuid4().hex[:12]
    limits = ["--network", "none", "--memory", "512m", "--memory-swap", "512m", "--cpus", "1", "--pids-limit", "128", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "0:0"]
    try:
        recovered = command([
            "docker", "run", "--name", name, *limits, "--cap-add", "DAC_OVERRIDE",
            "--mount", f"type=bind,src={recovery},dst=/recovery,readonly",
            "--mount", f"type=bind,src={candidate_patch},dst=/candidate-patch,readonly",
            source, "python3", "-B", "/recovery/recover.py",
            "--candidate-patch-root", "/candidate-patch", "--source-image-id", source, "--restore",
        ])
        original = metadata["Config"]
        changes = []
        for instruction, value in [("ENTRYPOINT", original.get("Entrypoint") or []), ("CMD", original.get("Cmd") or [])]:
            changes += ["--change", instruction + " " + json.dumps(value)]
        changes += ["--change", "USER " + (original.get("User") or "0:0")]
        changes += ["--change", "LABEL io.workbench.deerflow.recovery-source-image=" + source]
        changes += ["--change", "LABEL io.workbench.deerflow.recovery-manifest-sha256=" + hashlib.sha256(policy_bytes).hexdigest()]
        image_reference = "workbench-deerflow-base:1.0.0-recovered"
        command(["docker", "commit", *changes, name, image_reference])
    finally:
        subprocess.run(["docker", "rm", "-f", name], capture_output=True, check=False)
    # Preserve entrypoint, command, identity and environment from the source.
    final = json.loads(command(["docker", "image", "inspect", image_reference]))[0]
    image_id = final["Id"]
    assert_image_configuration(original, final["Config"])
    producer = subprocess.Popen(["docker", "image", "save", image_id], stdout=subprocess.PIPE)
    try:
        converted = subprocess.run([
            "docker", "run", "--rm", "-i", "--read-only", *limits,
            "--mount", f"type=bind,src={recovery},dst=/recovery,readonly",
            "--mount", f"type=bind,src={output},dst=/output",
            "--entrypoint", "python3", source, "-B", "/recovery/docker-save-to-oci.py",
            "--destination", "/output/oci", "--expected-image-id", image_id,
        ], stdin=producer.stdout, check=True, capture_output=True, text=True)
    finally:
        producer.stdout.close()
        producer.wait()
    if producer.returncode:
        raise ValueError("RECOVERY_DOCKER_SAVE_FAILED")
    receipt = {
        "applicationVersion": "1.0.0", "sourceImageId": source,
        "recoveredImageId": image_id,
        "recoveryManifestSha256": hashlib.sha256(policy_bytes).hexdigest(),
        "recovery": json.loads(recovered), "oci": json.loads(converted.stdout),
    }
    receipt["buildContext"] = "oci-layout://" + str(output / "oci") + "@" + receipt["oci"]["manifestDigest"]
    (output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    return receipt


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.candidate_root.resolve(), args.output.resolve())))
