#!/usr/bin/env python3
"""Stream one pinned docker-save image into a local OCI image layout."""

import argparse
import gzip
import hashlib
import json
from pathlib import Path
import sys
import tarfile


def json_bytes(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


def store_json(blobs, value):
    content = json_bytes(value)
    checksum = hashlib.sha256(content).hexdigest()
    (blobs / checksum).write_bytes(content)
    return {"digest": "sha256:" + checksum, "size": len(content)}


def descriptor_json(blobs, descriptor):
    filename = blobs / descriptor["digest"].removeprefix("sha256:")
    if not filename.is_file() or filename.stat().st_size != descriptor["size"] or descriptor["size"] > 16 * 1024 * 1024:
        raise ValueError("OCI_DESCRIPTOR_INVALID")
    value = filename.read_bytes()
    if "sha256:" + hashlib.sha256(value).hexdigest() != descriptor["digest"]:
        raise ValueError("OCI_DESCRIPTOR_HASH_MISMATCH")
    return json.loads(value)


def from_oci_archive(blobs, expected_image_id):
    root = blobs / expected_image_id[7:]
    descriptor = {"digest": expected_image_id, "size": root.stat().st_size}
    document = descriptor_json(blobs, descriptor)
    for _ in range(4):
        if "manifests" not in document:
            break
        candidates = [item for item in document["manifests"] if item.get("platform", {}).get("os") == "linux" and item.get("platform", {}).get("architecture") == "amd64"]
        if len(candidates) != 1:
            raise ValueError("OCI_PLATFORM_MANIFEST_AMBIGUOUS")
        descriptor = candidates[0]
        document = descriptor_json(blobs, descriptor)
    if "config" not in document or "layers" not in document:
        raise ValueError("OCI_IMAGE_MANIFEST_INVALID")
    config = descriptor_json(blobs, document["config"])
    if config.get("os") != "linux" or config.get("architecture") != "amd64":
        raise ValueError("OCI_PLATFORM_MISMATCH")
    diff_ids = config["rootfs"]["diff_ids"]
    if len(diff_ids) != len(document["layers"]):
        raise ValueError("OCI_LAYER_COUNT_MISMATCH")
    for layer, diff_id in zip(document["layers"], diff_ids):
        filename = blobs / layer["digest"].removeprefix("sha256:")
        if not filename.is_file() or filename.stat().st_size != layer["size"]:
            raise ValueError("OCI_LAYER_MISSING")
        media = layer["mediaType"]
        if media not in ["application/vnd.oci.image.layer.v1.tar", "application/vnd.oci.image.layer.v1.tar+gzip", "application/vnd.docker.image.rootfs.diff.tar.gzip"]:
            raise ValueError("OCI_LAYER_ENCODING_UNSUPPORTED")
        checksum = hashlib.sha256()
        with (gzip.open(filename, "rb") if media.endswith("gzip") else filename.open("rb")) as stream:
            while True:
                value = stream.read(1024 * 1024)
                if not value:
                    break
                checksum.update(value)
        if "sha256:" + checksum.hexdigest() != diff_id:
            raise ValueError("OCI_LAYER_DIFF_ID_MISMATCH")
    return {"mediaType": document["mediaType"], "digest": descriptor["digest"], "size": descriptor["size"]}, document["config"]["digest"], len(diff_ids)


def convert(source, destination, expected_image_id):
    if destination.exists() and any(destination.iterdir()):
        raise ValueError("OCI_DESTINATION_NOT_EMPTY")
    if len(expected_image_id) != 71 or not expected_image_id.startswith("sha256:"):
        raise ValueError("OCI_EXPECTED_IMAGE_ID_INVALID")
    blobs = destination / "blobs" / "sha256"
    blobs.mkdir(parents=True, mode=0o700)
    records = {}
    with tarfile.open(fileobj=source, mode="r|*") as archive:
        for entry in archive:
            if not entry.isfile():
                continue
            if entry.name in records:
                raise ValueError("OCI_DUPLICATE_ARCHIVE_ENTRY")
            stream = archive.extractfile(entry)
            checksum = hashlib.sha256()
            temporary = blobs / ".incoming"
            size = 0
            with temporary.open("wb") as output:
                while True:
                    chunk = stream.read(1024 * 1024)
                    if not chunk:
                        break
                    output.write(chunk)
                    checksum.update(chunk)
                    size += len(chunk)
            if size != entry.size:
                raise ValueError("OCI_ARCHIVE_SIZE_MISMATCH")
            hexadecimal = checksum.hexdigest()
            if entry.name.startswith("blobs/sha256/") and entry.name != "blobs/sha256/" + hexadecimal:
                raise ValueError("OCI_BLOB_HASH_MISMATCH")
            temporary.replace(blobs / hexadecimal)
            records[entry.name] = {"digest": "sha256:" + hexadecimal, "size": size}
    # Docker's containerd image store saves the original OCI index or manifest
    # as its image ID; the classic store instead uses the image config digest.
    if (blobs / expected_image_id[7:]).is_file():
        root_document = json.loads((blobs / expected_image_id[7:]).read_bytes())
        if "manifests" in root_document or "layers" in root_document:
            descriptor, config_digest, layer_count = from_oci_archive(blobs, expected_image_id)
            index = {"schemaVersion": 2, "manifests": [{**descriptor, "platform": {"os": "linux", "architecture": "amd64"}}]}
            (destination / "oci-layout").write_bytes(json_bytes({"imageLayoutVersion": "1.0.0"}))
            (destination / "index.json").write_bytes(json_bytes(index))
            return {"sourceImageId": expected_image_id, "manifestDigest": descriptor["digest"], "configDigest": config_digest, "layers": layer_count}
    manifest_record = records.get("manifest.json")
    if not manifest_record or manifest_record["size"] > 1024 * 1024:
        raise ValueError("OCI_DOCKER_MANIFEST_MISSING")
    docker_manifest = json.loads((blobs / manifest_record["digest"][7:]).read_bytes())
    candidates = [entry for entry in docker_manifest if records.get(entry["Config"], {}).get("digest") == expected_image_id]
    if len(candidates) != 1:
        raise ValueError("OCI_IMAGE_ID_MISMATCH")
    image = candidates[0]
    config_record = records[image["Config"]]
    if config_record["size"] > 16 * 1024 * 1024:
        raise ValueError("OCI_IMAGE_CONFIG_TOO_LARGE")
    config = json.loads((blobs / config_record["digest"][7:]).read_bytes())
    diff_ids = config["rootfs"]["diff_ids"]
    if len(diff_ids) != len(image["Layers"]):
        raise ValueError("OCI_LAYER_COUNT_MISMATCH")
    layers = []
    for layer, diff_id in zip(image["Layers"], diff_ids):
        record = records.get(layer)
        if not record or record["digest"] != diff_id:
            raise ValueError("OCI_LAYER_DIFF_ID_MISMATCH")
        layers.append({"mediaType": "application/vnd.oci.image.layer.v1.tar", **record})
    manifest = {
        "schemaVersion": 2,
        "mediaType": "application/vnd.oci.image.manifest.v1+json",
        "config": {"mediaType": "application/vnd.oci.image.config.v1+json", **config_record},
        "layers": layers,
    }
    descriptor = store_json(blobs, manifest)
    index = {"schemaVersion": 2, "manifests": [{
        "mediaType": "application/vnd.oci.image.manifest.v1+json", **descriptor,
        "annotations": {"org.opencontainers.image.ref.name": "workbench-base-1.0.0"},
        "platform": {"os": config["os"], "architecture": config["architecture"]},
    }]}
    # Write the layout entry points only after the config and every layer match.
    (destination / "oci-layout").write_bytes(json_bytes({"imageLayoutVersion": "1.0.0"}))
    (destination / "index.json").write_bytes(json_bytes(index))
    return {"sourceImageId": expected_image_id, "manifestDigest": descriptor["digest"], "layers": len(layers)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--expected-image-id", required=True)
    args = parser.parse_args()
    print(json.dumps(convert(sys.stdin.buffer, args.destination, args.expected_image_id)))
