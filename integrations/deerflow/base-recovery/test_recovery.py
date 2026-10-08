import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


recovery = module("recovery", "recover.py")
oci = module("oci", "docker-save-to-oci.py")
preparation = module("preparation", "prepare.py")


def checksum(value):
    return hashlib.sha256(value).hexdigest()


def archive(files):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w") as target:
        for name, content in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(content)
            target.addfile(info, io.BytesIO(content))
    stream.seek(0)
    return stream


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)

    def test_reverses_agent_to_exact_upstream_and_checks_new_patch(self):
        original = b"before\nanchor\nafter\n"
        old = {"anchor": "anchor\n", "insertion": "old-scope\n", "upstreamSha256": checksum(original), "patchedSha256": checksum(b"before\nold-scope\nanchor\nafter\n")}
        upstream = recovery.reverse_source(b"before\nold-scope\nanchor\nafter\n", old, True)
        self.assertEqual(upstream, original)
        candidate = {**old, "insertion": "new-scope\n", "patchedSha256": checksum(b"before\nnew-scope\nanchor\nafter\n")}
        recovery.verify_candidate_round_trip(upstream, candidate, True)

    def test_reverses_ordered_replacements_in_reverse_order(self):
        original = b"first\nanchor\nlast\n"
        replacements = [
            {"anchor": "anchor\n", "insertion": "inserted\n", "position": "before"},
            {"anchor": "inserted\nanchor\n", "insertion": "combined\n", "position": "replace"},
        ]
        entry = {"upstreamSha256": checksum(original), "patchedSha256": checksum(b"first\ncombined\nlast\n"), "replacements": replacements}
        self.assertEqual(recovery.reverse_source(b"first\ncombined\nlast\n", entry), original)
        recovery.verify_candidate_round_trip(original, entry)

    def test_drifted_source_and_forged_upstream_fail_closed(self):
        entry = {"anchor": "anchor", "insertion": "old", "patchedSha256": checksum(b"oldanchor"), "upstreamSha256": checksum(b"anchor")}
        with self.assertRaisesRegex(ValueError, "PATCHED_HASH_MISMATCH"):
            recovery.reverse_source(b"changed", entry, True)
        with self.assertRaisesRegex(ValueError, "UPSTREAM_HASH_MISMATCH"):
            recovery.reverse_source(b"oldanchor", {**entry, "upstreamSha256": "0" * 64}, True)
        with self.assertRaisesRegex(ValueError, "CANDIDATE_OUTPUT_MISMATCH"):
            recovery.verify_candidate_round_trip(b"anchor", {**entry, "patchedSha256": "0" * 64}, True)

    def test_protected_file_mismatch_prevents_any_source_write(self):
        source = self.base / "app/agent.py"
        source.parent.mkdir()
        source.write_bytes(b"unchanged source")
        policy = {"sourceFileSha256": {"/app/agent.py": checksum(b"unchanged source"), "/app/preserved.py": "0" * 64}}
        with self.assertRaisesRegex(ValueError, "SOURCE_NOT_REGULAR"):
            recovery.prepare_restore(self.base, self.base, policy)
        self.assertEqual(source.read_bytes(), b"unchanged source")

    def test_protected_symlink_is_not_accepted(self):
        source = self.base / "source.py"
        source.write_bytes(b"source")
        link = self.base / "linked.py"
        link.symlink_to(source)
        with self.assertRaisesRegex(ValueError, "SOURCE_NOT_REGULAR"):
            recovery.read_checked(link, checksum(b"source"))

    def test_image_configuration_rejects_recovery_command_or_identity_leaks(self):
        original = {"Entrypoint": None, "Cmd": ["server"], "User": "65532:65532", "Env": ["MODE=production"], "WorkingDir": "/app"}
        for key, value in [("Entrypoint", ["python3"]), ("Cmd", ["recover.py"]), ("User", "0:0"), ("Env", []), ("WorkingDir", "/tmp")]:
            with self.subTest(key=key):
                with self.assertRaisesRegex(ValueError, "CONFIGURATION_DRIFT: " + key):
                    preparation.assert_image_configuration(original, {**original, key: value})

    def test_image_configuration_accepts_equivalent_empty_entrypoint_serialization(self):
        preparation.assert_image_configuration({"Entrypoint": None, "Cmd": ["server"]}, {"Entrypoint": [], "Cmd": ["server"]})

    def docker_archive(self, layer=b"filesystem layer", actual_layer=None):
        config = oci.json_bytes({"os": "linux", "architecture": "amd64", "rootfs": {"type": "layers", "diff_ids": ["sha256:" + checksum(layer)]}})
        name = checksum(config) + ".json"
        files = {name: config, "layer/layer.tar": layer if actual_layer is None else actual_layer, "manifest.json": oci.json_bytes([{"Config": name, "Layers": ["layer/layer.tar"]}])}
        return archive(files), "sha256:" + checksum(config)

    def test_classic_docker_save_is_bound_to_config_and_layer_digests(self):
        source, image = self.docker_archive()
        result = oci.convert(source, self.base / "oci", image)
        self.assertEqual(result["sourceImageId"], image)
        index = json.loads((self.base / "oci/index.json").read_text())
        manifest = json.loads((self.base / "oci/blobs/sha256" / result["manifestDigest"][7:]).read_text())
        self.assertEqual(index["manifests"][0]["digest"], result["manifestDigest"])
        self.assertEqual(manifest["config"]["digest"], image)

    def test_wrong_image_or_layer_does_not_publish_oci_entry_points(self):
        source, image = self.docker_archive()
        with self.assertRaisesRegex(ValueError, "IMAGE_ID_MISMATCH"):
            oci.convert(source, self.base / "wrong-id", "sha256:" + "0" * 64)
        self.assertFalse((self.base / "wrong-id/index.json").exists())
        source, image = self.docker_archive(actual_layer=b"tampered")
        with self.assertRaisesRegex(ValueError, "LAYER_DIFF_ID_MISMATCH"):
            oci.convert(source, self.base / "wrong-layer", image)
        self.assertFalse((self.base / "wrong-layer/index.json").exists())

    def test_containerd_docker_save_verifies_index_manifest_config_and_gzip_layer(self):
        layer = b"filesystem layer"
        compressed = gzip.compress(layer, mtime=0)
        config = oci.json_bytes({"os": "linux", "architecture": "amd64", "rootfs": {"type": "layers", "diff_ids": ["sha256:" + checksum(layer)]}})
        descriptor = lambda value, media: {"digest": "sha256:" + checksum(value), "size": len(value), "mediaType": media}
        manifest = oci.json_bytes({"schemaVersion": 2, "mediaType": "application/vnd.oci.image.manifest.v1+json", "config": descriptor(config, "application/vnd.oci.image.config.v1+json"), "layers": [descriptor(compressed, "application/vnd.oci.image.layer.v1.tar+gzip")]})
        index = oci.json_bytes({"schemaVersion": 2, "manifests": [{**descriptor(manifest, "application/vnd.oci.image.manifest.v1+json"), "platform": {"os": "linux", "architecture": "amd64"}}]})
        files = {"blobs/sha256/" + checksum(value): value for value in [compressed, config, manifest, index]}
        image = "sha256:" + checksum(index)
        result = oci.convert(archive(files), self.base / "oci", image)
        self.assertEqual(result["manifestDigest"], "sha256:" + checksum(manifest))
        self.assertEqual(result["configDigest"], "sha256:" + checksum(config))
        files["blobs/sha256/" + checksum(compressed)] = b"tampered"
        with self.assertRaisesRegex(ValueError, "BLOB_HASH_MISMATCH"):
            oci.convert(archive(files), self.base / "tampered", image)


if __name__ == "__main__":
    unittest.main()
