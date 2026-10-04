#!/usr/bin/env python3
import json
import sys

data = json.load(sys.stdin)
if data.get("tool_name", "") == "get_output":
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "updatedInput": {"timeout": 1},
    }}))
