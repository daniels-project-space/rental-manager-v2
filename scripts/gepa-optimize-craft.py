#!/usr/bin/env python3
"""
gepa-optimize-craft.py — evolve the renter bot's CONVERSATION_CRAFT prompt.

GEPA (Genetic-Pareto, ICLR 2026) is a reflective prompt optimiser: it keeps a
pool of candidate prompts, runs them, reads a scalar score PLUS textual
feedback, and reflects on that feedback to mutate the prompt. Reported to beat
RL methods like GRPO by ~20% with ~35x fewer rollouts.

Why this project is an unusually good fit: the hard part of GEPA is supplying a
feedback function that says *what went wrong in words*, not just a number.
convex/lib/renter_bot_conversation_rubric.ts already emits exactly that — 10
mechanical checks with `detail` and `evidence` strings — and
scripts/renter-bot-conversation-test.mjs is already a rollout harness. This
driver just wires the two together.

COST. Every rollout is a real multi-turn LLM conversation, so this is a genuine
spend. It is bounded three ways: an explicit --budget (MaxMetricCallsStopper),
a small scenario set, and the fact that it runs OFFLINE — runtime cost is
unchanged or lower afterwards, since a better-instructed prompt escalates less
and a shorter one bills fewer tokens.

SAFETY. Candidates are injected via the route's secret-gated `craft_override`,
which is honoured only on `__probe__` threads and only swaps CRAFT rules —
never the ground-truth block, the tools, or any availability/price fact. An
optimiser therefore cannot talk the bot into an ungrounded claim.

WARNING — read before trusting the output: GEPA optimises toward whatever the
metric says. Our rubric has produced false positives during development. Fix
rubric precision first, or this will faithfully overfit to its mistakes.

Runs through Convex, which forwards the override to the draft route, so
RENTER_BOT_API_SECRET stays server-side and is never handled here.

  python3 scripts/gepa-optimize-craft.py --budget 30
"""
import argparse
import json
import re
import shutil
import subprocess  # noqa: S404 - trusted, fixed-argv local tooling only
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
EVAL = REPO / "scripts" / "gepa-eval-candidate.mjs"
ROUTE = REPO / "src" / "app" / "api" / "renter-bot-draft" / "route.ts"


def current_craft() -> str:
    """Pull the live CONVERSATION_CRAFT block out of the route as the seed."""
    src = ROUTE.read_text()
    m = re.search(r"const CONVERSATION_CRAFT = `(.*?)`;", src, re.S)
    if not m:
        sys.exit("Could not find CONVERSATION_CRAFT in route.ts — has it been renamed?")
    return m.group(1)


def evaluate(craft: str, scenarios):
    """Run the candidate through real conversations; return (score, feedback)."""
    job = json.dumps({"craft": craft, "scenarios": scenarios})
    node = shutil.which("node")
    if not node:
        return 0.0, "node not found on PATH"
    try:
        # Fixed argv, no shell, absolute interpreter path, input passed on
        # stdin rather than interpolated into a command line.
        out = subprocess.run(  # noqa: S603
            [node, str(EVAL)],
            input=job,
            capture_output=True,
            text=True,
            cwd=str(REPO),
            timeout=1800,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return 0.0, "evaluator timed out"
    line = (out.stdout or "").strip().splitlines()
    if not line:
        return 0.0, f"evaluator produced no output. stderr: {(out.stderr or '')[:400]}"
    try:
        res = json.loads(line[-1])
    except json.JSONDecodeError:
        return 0.0, f"evaluator output was not JSON: {line[-1][:300]}"
    return float(res.get("score", 0.0)), str(res.get("feedback", ""))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--budget",
        type=int,
        default=20,
        help="max metric calls (rollouts). Each is a real multi-turn conversation — keep it small.",
    )
    ap.add_argument(
        "--scenarios",
        default="bmpcc_lens_and_daycount,not_owned_graceful",
        help="comma-separated scenario names to optimise against",
    )
    ap.add_argument(
        "--reflection-model",
        default="google/gemini-3.7-flash",
        help="model GEPA uses to reflect on feedback and mutate the prompt",
    )
    ap.add_argument("--baseline-only", action="store_true", help="just score the current prompt and exit")
    args = ap.parse_args()

    scenarios = [s.strip() for s in args.scenarios.split(",") if s.strip()]
    seed = current_craft()

    print(f"scenarios: {scenarios}")
    print(f"seed prompt: {len(seed)} chars\n")

    print("scoring the CURRENT prompt as a baseline...")
    base_score, base_feedback = evaluate(seed, scenarios)
    print(f"baseline score: {base_score:.3f}")
    print(f"baseline feedback:\n{base_feedback}\n")

    if args.baseline_only:
        return

    try:
        import gepa  # type: ignore[import-not-found]
    except ImportError:
        sys.exit("gepa not installed — pip install gepa")

    # GEPA's default adapter works on {"input","additional_context","answer"}
    # records. Ours is a single evolving text component, so the dataset is one
    # trivial record and all the signal comes from the metric.
    trainset = [{"input": "renter conversation", "additional_context": "", "answer": ""}]

    def metric(example, prediction):  # noqa: ARG001
        craft = prediction if isinstance(prediction, str) else str(prediction)
        score, feedback = evaluate(craft, scenarios)
        print(f"  candidate scored {score:.3f}")
        return {"score": score, "feedback": feedback}

    print(f"running GEPA (budget {args.budget} rollouts)...\n")
    try:
        result = gepa.optimize(
            seed_candidate={"craft": seed},
            trainset=trainset,
            valset=trainset,
            adapter=None,
            task_lm=None,
            reflection_lm=args.reflection_model,
            metric=metric,
            stop_callbacks=[gepa.MaxMetricCallsStopper(args.budget)],
        )
    except TypeError as e:
        # The gepa API surface moves; fail loudly with what we know rather than
        # silently reporting a "result" that never optimised anything.
        sys.exit(
            f"gepa.optimize signature mismatch: {e}\n"
            "Check the installed gepa version's API and adjust this driver; "
            f"baseline score was {base_score:.3f} and is unaffected."
        )

    best = getattr(result, "best_candidate", None)
    print("\n=== RESULT ===")
    print(f"baseline: {base_score:.3f}")
    if best:
        out = REPO / "docs" / "gepa-optimized-craft.txt"
        text = best["craft"] if isinstance(best, dict) and "craft" in best else str(best)
        out.write_text(text)
        print(f"optimised prompt written to {out}")
        print("Review it by hand before pasting into route.ts — GEPA optimises toward")
        print("the metric, and the metric is not the same thing as a good reply.")
    else:
        print("no improved candidate found.")


if __name__ == "__main__":
    main()
