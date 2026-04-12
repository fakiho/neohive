#!/usr/bin/env python3
"""
Shared helpers for Cursor Agent hooks (stop / afterMCPExecution / beforeSubmitPrompt).
"""
from __future__ import annotations

import json
import os
import sys
from typing import Any


def neohive_dir_from_payload(payload: dict[str, Any]) -> str:
    env_dir = os.environ.get("NEOHIVE_DATA_DIR") or os.environ.get("NEOHIVE_DATA")
    if env_dir:
        return env_dir
    roots = payload.get("workspace_roots") or []
    if roots and isinstance(roots[0], str) and roots[0]:
        return os.path.join(roots[0], ".neohive")
    cwd = os.environ.get("CURSOR_PROJECT_DIR") or os.environ.get("PWD") or os.getcwd()
    return os.path.join(cwd, ".neohive")


def normalize_neohive_tool_name(payload: dict[str, Any]) -> str:
    tn = (payload.get("tool_name") or payload.get("tool") or "").strip()
    if not tn:
        tn = (payload.get("name") or "").strip()

    if tn.upper().startswith("MCP"):
        rest = tn[4:].strip() if tn[3:4] == ":" else tn.replace("MCP", "", 1).strip()
        if rest.startswith(":"):
            rest = rest[1:].strip()
        parts = [p.strip() for p in rest.split(":") if p.strip()]
        if len(parts) >= 2:
            return f"mcp__{parts[0]}__{parts[1]}"
        if len(parts) == 1:
            return f"mcp__neohive__{parts[0]}"

    if tn.startswith("mcp__"):
        return tn

    server = (payload.get("mcp_server") or payload.get("server") or payload.get("server_name") or "").strip()
    sub = (payload.get("mcp_tool") or "").strip()
    if server and sub:
        return f"mcp__{server}__{sub}"

    ti = payload.get("tool_input") or payload.get("arguments") or payload.get("params") or {}
    if isinstance(ti, dict):
        inner = (ti.get("name") or "").strip()
        if inner and server:
            return f"mcp__{server}__{inner}"

    return tn or "unknown"


def extract_register_name(payload: dict[str, Any]) -> str:
    ti = payload.get("tool_input") or payload.get("arguments") or payload.get("params") or {}
    if isinstance(ti, dict):
        n = ti.get("name")
        if isinstance(n, str) and n.strip():
            return n.strip()
    result = payload.get("result")
    if isinstance(result, dict):
        for k in ("name", "registered"):
            v = result.get(k)
            if isinstance(v, str) and v.strip():
                return v.strip()
    return "unknown"


LISTEN_REMINDER_SUFFIXES = frozenset(
    {
        "send_message",
        "broadcast",
        "update_task",
        "advance_workflow",
        "create_task",
        "create_workflow",
        "handoff",
        "share_file",
        "verify_and_advance",
        "start_plan",
        "request_review",
        "submit_review",
        "log_decision",
        "kb_write",
        "workspace_write",
        "lock_file",
        "unlock_file",
    }
)

STOP_ALLOW_SUFFIXES = frozenset(
    {
        "listen",
        "register",
        "get_briefing",
        "get_guide",
        "list_agents",
        "list_tasks",
        "messages",
        "get_summary",
        "get_decisions",
        "get_compressed_history",
        "check_dependencies",
        "get_progress",
        "kb_list",
        "kb_read",
        "workspace_list",
        "workspace_read",
        "list_channels",
        "workflow_status",
        "vote_status",
        "suggest_task",
        "list_rules",
        "get_notifications",
        "list_hooks",
        "get_reputation",
        "get_work",
    }
)


def tool_suffix(canonical: str) -> str:
    if "__" in canonical:
        parts = canonical.split("__")
        if len(parts) >= 3:
            return parts[-1]
    return canonical


def needs_listen_reminder(canonical: str) -> bool:
    return tool_suffix(canonical) in LISTEN_REMINDER_SUFFIXES


def stop_allows_without_listen(canonical: str) -> bool:
    suf = tool_suffix(canonical)
    if suf in STOP_ALLOW_SUFFIXES:
        return True
    if suf.startswith("listen"):
        return True
    return False


def main() -> None:
    if len(sys.argv) < 2:
        print("usage: cursor_hook_lib.py <neohive_dir|tool_name|register_name|needs_listen|stop_allow> [arg]", file=sys.stderr)
        sys.exit(1)
    cmd = sys.argv[1]
    if cmd in ("needs_listen", "stop_allow"):
        arg = sys.argv[2] if len(sys.argv) > 2 else ""
        if cmd == "needs_listen":
            print("yes" if needs_listen_reminder(arg) else "no")
        else:
            print("yes" if stop_allows_without_listen(arg) else "no")
        return
    payload = json.load(sys.stdin)
    if cmd == "neohive_dir":
        print(neohive_dir_from_payload(payload))
    elif cmd == "tool_name":
        print(normalize_neohive_tool_name(payload))
    elif cmd == "register_name":
        print(extract_register_name(payload))
    else:
        print(json.dumps({"error": f"unknown command {cmd}"}))
        sys.exit(1)


if __name__ == "__main__":
    main()
