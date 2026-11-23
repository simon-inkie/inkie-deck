#!/usr/bin/env python3
import hashlib
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock


HERE = Path(__file__).resolve().parent
CLI = HERE.parent / "bin" / "codex-provider-switch"
LOCK = HERE.parent / "bin" / "provider-switch-lock"
PUSH = HERE.parent / "bin" / "inbox-push"
BOOT = HERE.parent / "bin" / "boot-agents.sh"


def load_cli():
    loader = importlib.machinery.SourceFileLoader("provider_switch", str(CLI))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


class ProviderSwitchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.agents = self.root / "agents"
        self.state = self.root / "state"
        self.agent = self.agents / "alex"
        (self.agent / ".codex-home" / "sessions").mkdir(parents=True)
        (self.agent / ".codex-home" / "config.toml").write_text(
            'model_provider = "azure"\n', encoding="utf-8"
        )
        (self.agent / ".runtime").write_text("codex\n", encoding="utf-8")
        (self.agent / ".role").write_text("copywriter\n", encoding="utf-8")
        self.env = os.environ.copy()
        self.env.update(
            {
                "PROVIDER_SWITCH_AGENTS_ROOT": str(self.agents),
                "PROVIDER_SWITCH_STATE_ROOT": str(self.state),
                "PROVIDER_SWITCH_NOW": "1789516800",
                "PROVIDER_SWITCH_TOKEN": "T" * 43,
                "PROVIDER_SWITCH_NONCE": "0123456789abcdef0123456789abcdef",
                "PROVIDER_SWITCH_QUIESCE_DELAY": "0",
                "PROVIDER_SWITCH_START_TIMEOUT": "0",
            }
        )

    def tearDown(self):
        self.tmp.cleanup()

    def test_lock_is_atomic_and_owner_bound(self):
        first = subprocess.run(
            [str(LOCK), "acquire", "alex", "11111111-1111-4111-8111-111111111111"],
            env=self.env,
            text=True,
            capture_output=True,
        )
        second = subprocess.run(
            [str(LOCK), "acquire", "alex", "22222222-2222-4222-8222-222222222222"],
            env=self.env,
            text=True,
            capture_output=True,
        )
        wrong_release = subprocess.run(
            [str(LOCK), "release", "alex", "22222222-2222-4222-8222-222222222222"],
            env=self.env,
        )
        self.assertEqual(first.returncode, 0)
        self.assertNotEqual(second.returncode, 0)
        self.assertNotEqual(wrong_release.returncode, 0)
        self.assertTrue((self.state / "alex" / "provider-switch.lock").is_dir())

    def test_prepare_rejects_missing_azure_home(self):
        (self.agent / ".codex-home" / "config.toml").unlink()
        result = subprocess.run(
            [str(CLI), "prepare", "alex"], env=self.env, text=True, capture_output=True
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("Azure home", result.stderr)

    def test_prepare_rejects_provisioned_azure_without_authoritative_plus_state(self):
        result = subprocess.run(
            [str(CLI), "prepare", "alex"], env=self.env, text=True, capture_output=True
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("authoritative provider state showing plus", result.stderr)
        self.assertFalse((self.state / "alex" / "provider-switch.lock").exists())

    def test_pty_opt_in_refuses_prepare_and_launch(self):
        (self.agent / ".runner").write_text("pty\n", encoding="utf-8")
        (self.agent / ".runtime").write_text("claude\n", encoding="utf-8")
        tmux = self.root / "tmux"
        tmux.write_text('#!/bin/sh\ntouch "$TMUX_LOG"\nexit 1\n', encoding="utf-8")
        tmux.chmod(0o755)
        tmux_log = self.root / "tmux.log"
        env = {**self.env, "PROVIDER_SWITCH_TMUX_BIN": str(tmux), "TMUX_LOG": str(tmux_log)}
        transaction = "11111111-1111-4111-8111-111111111111"
        env.pop("MC_PTY_RUNNER", None)
        for marker in (".runner", ".runner.lock"):
            (self.agent / ".runner").unlink(missing_ok=True)
            (self.agent / marker).write_text("pty\n", encoding="utf-8")
            for args in (("prepare", "alex"), ("launch", "alex", transaction, "T" * 43)):
                with self.subTest(marker=marker, command=args[0]):
                    result = subprocess.run([str(CLI), *args], env=env, text=True, capture_output=True)
                    self.assertEqual(result.returncode, 2)
                    self.assertIn("opted into the PTY runner", result.stderr)
                    self.assertFalse(tmux_log.exists())
                    self.assertFalse(self.state.exists())

    def test_validate_agent_rejects_shell_metacharacters(self):
        result = subprocess.run(
            [str(CLI), "status", "alex;touch-pwned"],
            env=self.env,
            text=True,
            capture_output=True,
        )
        self.assertEqual(result.returncode, 2)
        self.assertFalse((self.root / "pwned").exists())

    def test_confirmation_is_one_use_and_bound(self):
        mod = load_cli()
        tx = {
            "agent": "alex",
            "transaction_id": "11111111-1111-4111-8111-111111111111",
            "target_provider": "azure",
            "pane_id": "%9",
            "token_hash": hashlib.sha256(("T" * 43).encode()).hexdigest(),
            "token_expires_at": 1789516860,
            "token_used_at": None,
        }
        mod.validate_confirmation(tx, "T" * 43, 1789516800, "%9")
        tx["token_used_at"] = 1789516800
        with self.assertRaises(mod.SwitchError):
            mod.validate_confirmation(tx, "T" * 43, 1789516800, "%9")
        tx["token_used_at"] = None
        with self.assertRaises(mod.SwitchError):
            mod.validate_confirmation(tx, "T" * 43, 1789516800, "%10")

    def test_azure_command_uses_constructor_fresh(self):
        mod = load_cli()
        expected_home = str(self.agent / ".codex-home")
        with mock.patch.object(
            mod.subprocess,
            "run",
            return_value=subprocess.CompletedProcess([], 0, stdout="AZURE-COMMAND\n", stderr=""),
        ) as run:
            command = mod.provider_command("alex", "copywriter", expected_home)
        self.assertEqual(command, "AZURE-COMMAND")
        argv = run.call_args.args[0]
        self.assertEqual(argv[0:2], ["bash", "-c"])
        self.assertEqual(argv[-3:], ["copywriter", expected_home, ""])
        self.assertNotIn("resume", command)

    def test_rollout_verification_requires_new_user_nonce(self):
        mod = load_cli()
        session = self.agent / ".codex-home" / "sessions" / "2026" / "09" / "16"
        session.mkdir(parents=True)
        rollout = session / "rollout-2026-09-16T01-00-00-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl"
        records = [
            {
                "type": "session_meta",
                "payload": {
                    "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                    "cwd": str(self.agent),
                    "originator": "codex-tui",
                    "thread_source": "user",
                },
            },
            {
                "type": "response_item",
                "payload": {
                    "role": "user",
                    "content": [{"type": "input_text", "text": "nonce 0123456789abcdef0123456789abcdef"}],
                },
            },
            {
                "type": "response_item",
                "payload": {
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "CANARY OK"}],
                },
            },
        ]
        rollout.write_text("\n".join(json.dumps(x) for x in records) + "\n", encoding="utf-8")
        os.utime(rollout, (1789516801, 1789516801))
        found = mod.find_verified_rollout(
            self.agent / ".codex-home" / "sessions",
            str(self.agent),
            "0123456789abcdef0123456789abcdef",
            1789516800,
            "old-thread",
        )
        self.assertEqual(found, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        with self.assertRaises(mod.SwitchError):
            mod.find_verified_rollout(
                self.agent / ".codex-home" / "sessions",
                str(self.agent),
                "ffffffffffffffffffffffffffffffff",
                1789516800,
                "old-thread",
            )

    def test_delivery_surfaces_contain_provider_switch_gate(self):
        for name in [
            "inbox-push",
        ]:
            text = (CLI.parent / name).read_text(encoding="utf-8")
            self.assertIn("provider-switch-lock", text, name)
            self.assertIn("provider-switch", text, name)

    def test_inbox_push_returns_provider_switch_skip(self):
        transaction = "11111111-1111-4111-8111-111111111111"
        subprocess.run([str(LOCK), "acquire", "alex", transaction], env=self.env, check=True)
        env = {**self.env, "PANE_OVERRIDE": "unused", "AGENT_NAME": "scribe"}
        result = subprocess.run(
            [str(PUSH), "alex", "hello"], env=env, text=True, capture_output=True
        )
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout.strip(), "skip:provider-switch")

    def test_boot_provider_selector_honours_committed_plus(self):
        provider_dir = self.state / "alex" / "provider-switch"
        provider_dir.mkdir(parents=True)
        (provider_dir / "provider.json").write_text('{"provider":"plus"}\n', encoding="utf-8")
        program = (
            'BOOT_AGENTS_LIB_ONLY=1 source "$1"; '
            'PROVIDER_SWITCH_STATE_ROOT="$2" HOME="$3" codex_home_for_agent alex'
        )
        result = subprocess.run(
            ["bash", "-c", program, "test", str(BOOT), str(self.state), str(self.root)],
            text=True,
            capture_output=True,
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "\n")

    def test_boot_provider_selector_fails_closed_on_malformed_state(self):
        provider_dir = self.state / "alex" / "provider-switch"
        provider_dir.mkdir(parents=True)
        (provider_dir / "provider.json").write_text('{broken\n', encoding="utf-8")
        program = (
            'BOOT_AGENTS_LIB_ONLY=1 source "$1"; '
            'PROVIDER_SWITCH_STATE_ROOT="$2" HOME="$3" codex_home_for_agent alex'
        )
        result = subprocess.run(
            ["bash", "-c", program, "test", str(BOOT), str(self.state), str(self.root)],
            text=True,
            capture_output=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("malformed", result.stderr)

    def test_failed_launch_shell_is_eligible_for_exact_pane_rollback(self):
        mod = load_cli()
        with mock.patch.object(mod, "pane_details", return_value=("%9", "bash", str(self.agent))), mock.patch.object(
            mod.time, "sleep"
        ):
            pane, command, cwd = mod.confirm_rollback_ready("alex", "%9")
        self.assertEqual((pane, command, cwd), ("%9", "bash", str(self.agent)))

    def test_failed_launch_rolls_back_fresh_plus_then_finalise_releases_lock(self):
        mod = load_cli()
        transaction = "11111111-1111-4111-8111-111111111111"
        tx = {
            "schema_version": 1,
            "transaction_id": transaction,
            "agent": "alex",
            "stage": "launching",
            "source_provider": "plus",
            "target_provider": "azure",
            "pane_id": "%9",
            "working_directory": str(self.agent),
            "azure_home": str(self.agent / ".codex-home"),
        }
        with mock.patch.dict(os.environ, self.env, clear=True):
            mod.atomic_json(mod.transaction_path("alex"), tx)
            subprocess.run([str(LOCK), "acquire", "alex", transaction], env=self.env, check=True)
            sent = []
            with mock.patch.object(
                mod, "confirm_rollback_ready", return_value=("%9", "bash", str(self.agent))
            ), mock.patch.object(
                mod, "send_fresh", side_effect=lambda pane, command: sent.append((pane, command))
            ), mock.patch.object(mod, "wait_for_clean_codex", return_value=None):
                mod.rollback("alex", transaction)
            self.assertEqual(len(sent), 1)
            self.assertEqual(sent[0][0], "%9")
            self.assertIn(" codex", sent[0][1])
            self.assertNotIn("CODEX_HOME=", sent[0][1])
            self.assertNotIn(" resume ", f" {sent[0][1]} ")
            provider = json.loads(mod.provider_path("alex").read_text(encoding="utf-8"))
            self.assertEqual(provider["provider"], "plus")
            legacy_provider = json.loads(
                (Path(self.env["PROVIDER_SWITCH_STATE_ROOT"]) / "provider-switch" / "current" / "alex.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(legacy_provider["provider"], "plus")
            self.assertEqual(subprocess.run([str(LOCK), "active", "alex"], env=self.env).returncode, 0)
            mod.finalise("alex", transaction)
            final_tx = json.loads(mod.transaction_path("alex").read_text(encoding="utf-8"))
            self.assertEqual(final_tx["stage"], "finalised")
            self.assertEqual(final_tx["outcome"], "rolled-back")
            self.assertNotEqual(subprocess.run([str(LOCK), "active", "alex"], env=self.env).returncode, 0)

    def test_rollback_refuses_commit_when_replacement_codex_never_starts(self):
        mod = load_cli()
        transaction = "33333333-3333-4333-8333-333333333333"
        tx = {
            "schema_version": 1,
            "transaction_id": transaction,
            "agent": "alex",
            "stage": "launching",
            "source_provider": "plus",
            "target_provider": "azure",
            "pane_id": "%9",
            "working_directory": str(self.agent),
            "azure_home": str(self.agent / ".codex-home"),
        }
        with mock.patch.dict(os.environ, self.env, clear=True):
            mod.atomic_json(mod.transaction_path("alex"), tx)
            subprocess.run([str(LOCK), "acquire", "alex", transaction], env=self.env, check=True)
            with mock.patch.object(
                mod, "confirm_rollback_ready", return_value=("%9", "bash", str(self.agent))
            ), mock.patch.object(mod, "send_fresh", return_value=None), mock.patch.object(
                mod, "wait_for_clean_codex", side_effect=mod.SwitchError("launcher refused lock")
            ):
                with self.assertRaises(mod.SwitchError):
                    mod.rollback("alex", transaction)
            self.assertFalse(mod.provider_path("alex").exists())
            stored_tx = json.loads(mod.transaction_path("alex").read_text(encoding="utf-8"))
            self.assertEqual(stored_tx["stage"], "launching")

    def test_abort_prepared_releases_lock(self):
        mod = load_cli()
        transaction = "22222222-2222-4222-8222-222222222222"
        tx = {
            "schema_version": 1,
            "transaction_id": transaction,
            "agent": "alex",
            "stage": "prepared",
            "source_provider": "plus",
            "target_provider": "azure",
            "pane_id": "%9",
            "working_directory": str(self.agent),
            "azure_home": str(self.agent / ".codex-home"),
        }
        with mock.patch.dict(os.environ, self.env, clear=True):
            mod.atomic_json(mod.transaction_path("alex"), tx)
            subprocess.run([str(LOCK), "acquire", "alex", transaction], env=self.env, check=True)
            self.assertEqual(subprocess.run([str(LOCK), "active", "alex"], env=self.env).returncode, 0)
            mod.abort("alex", transaction)
            aborted_tx = json.loads(mod.transaction_path("alex").read_text(encoding="utf-8"))
            self.assertEqual(aborted_tx["stage"], "aborted")
            self.assertNotEqual(subprocess.run([str(LOCK), "active", "alex"], env=self.env).returncode, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
