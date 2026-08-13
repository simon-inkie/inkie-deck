#!/usr/bin/env python3
"""
Run the shared conformance corpus against the Python CLI (bin/inbox).

This is the CLI half of the drift mechanism. Its counterpart is the
application's own runner in packages/deck; the two share only corpus.json,
because a Python CLI and a TypeScript application have no code they can share.
See docs/conformance.md for the design and the rules for adding a case.

Usage:
  python3 conformance/run_cli.py            run every case, exit non-zero on failure
  python3 conformance/run_cli.py --list     print the canonical projection per case

Exit codes: 0 all cases satisfied, 1 at least one failure.
"""
import json
import os
import sys
from importlib.machinery import SourceFileLoader
import importlib.util

IMPL = "cli"
HERE = os.path.dirname(os.path.abspath(__file__))
PACKAGE_ROOT = os.path.dirname(HERE)
CORPUS_PATH = os.path.join(HERE, "corpus.json")
INBOX_PATH = os.path.join(PACKAGE_ROOT, "bin", "inbox")


def load_inbox():
    """Import bin/inbox as a module.

    It has no .py extension (it is a CLI on PATH), so the loader is named
    explicitly rather than inferred from the suffix. Importing is safe: the
    module only runs main() under `if __name__ == "__main__"`.
    """
    loader = SourceFileLoader("inbox_under_test", INBOX_PATH)
    spec = importlib.util.spec_from_loader("inbox_under_test", loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def project(inbox, text):
    """Project the CLI's parse onto the corpus's canonical block shape.

    The adapter is deliberately thin and does no interpretation: everything it
    reports comes straight off parse_blocks. bodyRaw is recomputed from the
    block's own offsets rather than taken from block["body"], because "body" is
    the CLI's PRESENTATION cleaning (it drops standalone '---' lines) and the
    corpus compares raw block extents so that legitimate differences in display
    cleaning do not masquerade as boundary drift.
    """
    blocks = []
    for b in inbox.parse_blocks(text):
        header_end = b["start"] + len(b["header_line"])
        body_raw = text[header_end:b["end"]].strip()
        blocks.append({
            "ts": b["ts"],
            "sender": b["sender"],
            "status": b["status"],
            "subject": b["subject"],
            "bodyRaw": body_raw,
        })
    return blocks


def describe(blocks):
    return json.dumps(blocks, indent=2, ensure_ascii=False)


def main(argv):
    inbox = load_inbox()
    with open(CORPUS_PATH, encoding="utf-8") as f:
        corpus = json.load(f)

    if "--list" in argv:
        for case in corpus["cases"]:
            print("== %s" % case["id"])
            print(describe(project(inbox, case["input"])))
        return 0

    failures = []
    stale = []
    passed = 0
    deviations_honoured = 0

    for case in corpus["cases"]:
        actual = project(inbox, case["input"])
        expected = case["expect"]
        deviation = (case.get("deviations") or {}).get(IMPL)

        if deviation is None:
            if actual == expected:
                passed += 1
            else:
                failures.append((case, expected, actual, "does not match the protocol"))
            continue

        # A deviation is recorded for this implementation. TWO assertions, and
        # the second is the one that stops this mechanism certifying drift.
        if actual == expected:
            # The deviation has been FIXED. That is good news and it still
            # fails, loudly: a waiver that outlives the defect it documents is
            # how a conformance suite starts lying. Delete the record.
            stale.append(case)
        elif actual != deviation["expect"]:
            # The deviation still exists but has CHANGED SHAPE, so the recorded
            # description of it is now wrong too.
            failures.append(
                (case, deviation["expect"], actual,
                 "deviates from the protocol in a way that no longer matches its own record")
            )
        else:
            deviations_honoured += 1

    for case, expected, actual, why in failures:
        print("FAIL %s (protocol section %s): %s" % (case["id"], case["protocol"], why))
        print("  why this case exists: %s" % case["why"])
        print("  expected:\n%s" % describe(expected))
        print("  actual:\n%s" % describe(actual))
        print()

    for case in stale:
        print("FAIL %s: STALE DEVIATION RECORD." % case["id"])
        print("  The '%s' implementation now matches the protocol for this case," % IMPL)
        print("  so the deviation recorded against it in corpus.json is obsolete.")
        print("  Delete deviations.%s from case '%s'." % (IMPL, case["id"]))
        print()

    total = len(corpus["cases"])
    print(
        "conformance (%s): %d/%d conforming, %d known deviation(s) honoured, "
        "%d failure(s), %d stale record(s)"
        % (IMPL, passed, total, deviations_honoured, len(failures), len(stale))
    )
    return 1 if (failures or stale) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
