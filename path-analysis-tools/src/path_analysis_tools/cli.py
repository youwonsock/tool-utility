"""JSON-in/JSON-out CLI; diagnostics go to stderr, images require --output."""
from __future__ import annotations

import argparse
import json
import sys

from .documents import ContractError, load, loads
from .service import Service, TOOLS


def main(argv=None):
    parser = argparse.ArgumentParser(description="Independent Path Analysis Tools")
    parser.add_argument("--workspace", required=True)
    parser.add_argument("tool", choices=["server_info", *TOOLS])
    parser.add_argument("--input", help="JSON request file, inside workspace; otherwise stdin")
    parser.add_argument("--output", help="Workspace-relative JSON or PNG output")
    args = parser.parse_args(argv)
    try:
        service = Service(args.workspace)
        if args.tool == "server_info":
            result = service.info()
        else:
            request = load(service.workspace.resolve(args.input, existing=True)) if args.input else loads(sys.stdin.read())
            if args.output:
                request["output"] = args.output
            result = service.call(args.tool, request)
            if isinstance(result, bytes):
                raise ContractError("OUTPUT_REQUIRED", "CLI image tools require --output ending in .png.")
        print(json.dumps(result, ensure_ascii=False, allow_nan=False))
        return 0
    except (ContractError, ValueError, OSError, KeyError, TypeError) as exception:
        print(json.dumps({"error": {"code": getattr(exception, "code", "INVALID_REQUEST"), "message": str(exception)}}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
