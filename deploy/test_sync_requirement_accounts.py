import copy
import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location("account_sync", pathlib.Path(__file__).with_name("sync-requirement-accounts.py"))
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)

SOURCE_ID = "a" * 32
USER_ID = "12345678-1234-4234-8234-123456789012"
PASSWORD = "$2a$10$" + "a" * 53


def source(**changes):
    return dict(dict(sourceId=SOURCE_ID, email="member@example.com", name="Member",
                     password=PASSWORD, active=True), **changes)


def target(password="apitable-bcrypt:" + PASSWORD):
    return dict(users=[dict(id=USER_ID, email="member@example.com", name="Member")],
                accounts=[dict(user_id=USER_ID, account_id=SOURCE_ID, provider_id="apitable-sync"),
                          dict(user_id=USER_ID, account_id=USER_ID, provider_id="credential", password=password)])


class SyncPlanTests(unittest.TestCase):
    def test_creates_a_missing_member_and_normalizes_email(self):
        result = sync.plan_sync([source(email="Member@Example.com")], dict(users=[], accounts=[]))
        self.assertEqual(len(result), 1)
        self.assertTrue(result[0]["created"])
        self.assertEqual(result[0]["email"], "member@example.com")
        self.assertFalse(result[0]["revoke"])

    def test_second_run_does_not_write_or_revoke_sessions(self):
        self.assertEqual(sync.plan_sync([source()], target()), [])

    def test_password_change_preserves_identity_and_revokes_sessions(self):
        result = sync.plan_sync([source()], target("native-workbench-password"))
        self.assertEqual(result[0]["userId"], USER_ID)
        self.assertTrue(result[0]["revoke"])
        self.assertFalse(result[0]["created"])

    def test_removal_or_suspension_disables_only_linked_members(self):
        for rows in [[], [source(active=False)]]:
            result = sync.plan_sync(rows, target())
            self.assertEqual(len(result), 1)
            self.assertFalse(result[0]["active"])
            self.assertTrue(result[0]["revoke"])
        self.assertEqual(sync.plan_sync([], dict(users=target()["users"], accounts=[])), [])

    def test_reactivation_restores_source_password(self):
        result = sync.plan_sync([source()], target("apitable-disabled:" + SOURCE_ID))
        self.assertTrue(result[0]["active"])
        self.assertTrue(result[0]["revoke"])

    def test_profile_change_keeps_sessions_and_identity(self):
        result = sync.plan_sync([source(name="New name")], target())
        self.assertEqual(result[0]["userId"], USER_ID)
        self.assertFalse(result[0]["revoke"])

    def test_stable_source_id_handles_email_changes(self):
        result = sync.plan_sync([source(email="new@example.com")], target())
        self.assertEqual(result[0]["userId"], USER_ID)
        self.assertTrue(result[0]["revoke"])

    def test_duplicate_or_invalid_source_does_not_produce_a_partial_plan(self):
        for rows in [[source(), source()], [source(password="malformed")],
                     [source(), source(sourceId="b" * 32)], [source(email="invalid")]]:
            with self.assertRaises(ValueError):
                sync.plan_sync(rows, target())

    def test_cannot_merge_distinct_source_identities(self):
        with self.assertRaises(ValueError):
            sync.plan_sync([source(sourceId="b" * 32)], target())

    def test_email_alone_cannot_take_over_an_unlinked_native_account(self):
        existing = target()
        existing["accounts"] = [existing["accounts"][1]]
        with self.assertRaises(ValueError):
            sync.plan_sync([source()], existing)

    def test_rejects_email_collision_and_multiple_credentials(self):
        conflicting = copy.deepcopy(target())
        conflicting["users"].append(dict(id="other", email="new@example.com", name="Other"))
        with self.assertRaises(ValueError):
            sync.plan_sync([source(email="new@example.com")], conflicting)
        conflicting = target()
        conflicting["accounts"].append(copy.deepcopy(conflicting["accounts"][1]))
        with self.assertRaises(ValueError):
            sync.plan_sync([source()], conflicting)


if __name__ == "__main__":
    unittest.main()
