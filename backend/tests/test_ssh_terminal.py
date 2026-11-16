from __future__ import annotations

import os
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

import sys

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from svl364_ssh_mcp import SVL364SshMcpController


class FakeKernel:
    def list_system_modules(self) -> list[dict[str, object]]:
        return []

    def append_terminal_entry(self, *_args: object, **_kwargs: object) -> None:
        return None

    def get_server_revision(self) -> int:
        return 1


def build_controller() -> SVL364SshMcpController:
    controller = object.__new__(SVL364SshMcpController)
    controller.kernel = FakeKernel()
    controller.project_root = Path.cwd()
    controller.ssh_connected = False
    controller.recent_activity = []
    controller.ssh_sessions_count = 0
    controller.mcp_calls_count = 0
    return controller


class SshTerminalTests(unittest.TestCase):
    def test_remote_execution_requires_explicit_confirmation(self) -> None:
        controller = build_controller()
        with patch("svl364_ssh_mcp.subprocess.run") as run:
            result = controller.execute_ssh_command("uname -a")

        self.assertFalse(result["ok"])
        self.assertIn("potwierdzenia", result["error"])
        run.assert_not_called()

    def test_confirmed_command_uses_configured_ssh_alias_not_local_shell(self) -> None:
        controller = build_controller()
        completed = subprocess.CompletedProcess(args=["ssh"], returncode=0, stdout="remote-host\n", stderr="")
        with (
            patch.dict(os.environ, {"SVL_SSH_TARGET": "Ship"}),
            patch("svl364_ssh_mcp.shutil.which", return_value="/usr/bin/ssh"),
            patch("svl364_ssh_mcp.subprocess.run", return_value=completed) as run,
        ):
            result = controller.execute_ssh_command("uname -a", confirmed=True)

        self.assertTrue(result["ok"])
        self.assertEqual(result["sshEndpoint"], "ssh://Ship")
        command = run.call_args.args[0]
        self.assertEqual(command[0], "/usr/bin/ssh")
        self.assertIn("Ship", command)
        self.assertEqual(command[-1], "/bin/bash -lc 'uname -a'")
        self.assertNotIn("shell", run.call_args.kwargs)

    def test_ssh_failure_does_not_run_command_locally(self) -> None:
        controller = build_controller()
        failed = subprocess.CompletedProcess(args=["ssh"], returncode=255, stdout="", stderr="connection failed")
        with (
            patch.dict(os.environ, {"SVL_SSH_TARGET": "Ship"}),
            patch("svl364_ssh_mcp.shutil.which", return_value="/usr/bin/ssh"),
            patch("svl364_ssh_mcp.subprocess.run", return_value=failed) as run,
        ):
            result = controller.execute_ssh_command("uname -a", confirmed=True)

        self.assertFalse(result["ok"])
        self.assertFalse(controller.ssh_connected)
        self.assertEqual(run.call_count, 1)
        self.assertEqual(run.call_args.args[0][0], "/usr/bin/ssh")


if __name__ == "__main__":
    unittest.main()
