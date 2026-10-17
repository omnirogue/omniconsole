import json
import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace
import checkpoint
from request_limits import check_request, parse_request


class Tokenizer:
    mask_token = "[MASK]"

    def __call__(self, text, **_):
        return {"input_ids": text.split()}


class RequestLimits(unittest.TestCase):
    def setUp(self):
        self.agent = SimpleNamespace(tok=Tokenizer(), cfg={"head_max_len": 256, "max_len": 1024},
                                     _to_internal=lambda q: {"ins": q["instructions"]})
        self.request = {"protocol": "test", "model": "test", "state": "evidence", "questions": {
            "answer": {"type": "choice", "instructions": "choose", "criteria": {"a": None, "b": None}}}}

    def check(self, options=None):
        check_request(self.agent, self.request, lambda _: options or ["a", "b"], lambda s: s if isinstance(s, str) else json.dumps(s))

    def test_short_input_is_admitted(self):
        self.check()

    def test_rejects_each_upstream_truncation_boundary(self):
        with self.assertRaisesRegex(ValueError, "input_too_large"):
            self.check(["word " * 49, "b"])
        self.request["questions"]["answer"]["instructions"] = "word " * 255
        with self.assertRaisesRegex(ValueError, "input_too_large"):
            self.check()
        self.request["questions"]["answer"]["instructions"] = "choose"
        self.request["state"] = "word " * 1024
        with self.assertRaisesRegex(ValueError, "input_too_large"):
            self.check()

    def test_mask_tokens_cannot_be_silently_replaced(self):
        self.request["state"] = "[MASK] evidence"
        with self.assertRaisesRegex(ValueError, "invalid_request"):
            self.check()

    def test_duplicate_and_nonfinite_json_rejected(self):
        for text in ['{"state":1,"state":2}', '{"state":NaN}', '{"state":Infinity}']:
            with self.assertRaises(ValueError):
                parse_request(text)

    def test_checkpoint_corruption_and_extra_files_refused(self):
        import hashlib
        content = b"model fixture"
        digest = hashlib.sha256(content).hexdigest()
        manifest = {"modelFiles": {"weights": digest}, "sourceFiles": {},
                    "modelRepository": "fixture", "modelRevision": "fixture"}
        with tempfile.TemporaryDirectory() as directory, patch.object(checkpoint, "MANIFEST", manifest):
            root = Path(directory)
            (root / "model").mkdir()
            target = root / "model" / "weights"
            target.write_bytes(content)
            checkpoint.verify(root)
            target.write_bytes(b"corrupt")
            with self.assertRaisesRegex(ValueError, "checkpoint_integrity_failed"):
                checkpoint.verify(root)
            target.write_bytes(content)
            (root / "model" / "unreviewed.py").write_bytes(b"print('extra')")
            with self.assertRaisesRegex(ValueError, "checkpoint_unexpected_files"):
                checkpoint.verify(root)


if __name__ == "__main__":
    unittest.main()
