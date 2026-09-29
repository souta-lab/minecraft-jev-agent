#!/usr/bin/env python3
import json
import sys

data = json.load(sys.stdin)
tool = data.get("tool_name", "")
args = data.get("tool_input") or {}

if tool == "run_subagent":
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "updatedInput": {"is_background": True},
    }}))
elif tool == "read_subagent":
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "updatedInput": {"block": False},
    }}))
elif tool == "get_output":
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "updatedInput": {"timeout": 1},
    }}))
