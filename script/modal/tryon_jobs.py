"""The try-on service's job endpoints, the parts with no Modal or FastAPI in them: what a start request may
carry, what a call id looks like, and how a call's state becomes an HTTP answer. tryon_service.py's `jobs`
web app is these plus Modal's calls; this module is copied into its small CPU image (it needs only the
standard library), and tested in test_tryon_jobs.py.

    POST /start         body as the old endpoint's      -> 200 {id}            ({warm: true} spawns a wake-up)
    GET  /result/{id}                                   -> 202 {status: "pending", phase: "starting"|"painting"}
                                                        -> 200 {status: "done", ok, image?, checks, seconds}
                                                        -> 200 {status: "failed", error}   (410 once expired)
    POST /cancel/{id}                                   -> 200 {status: "cancelled"}
"""

import re

# Modal's function call ids (FunctionCall.object_id) are "fc-" and a base62 tail.
CALL_ID = re.compile(r"\Afc-[A-Za-z0-9]{1,64}\Z")
# What a paint request may carry (tryon_engine.parse_request reads these); anything else is dropped.
FIELDS = ("person", "garment", "category", "mask", "outline", "print", "pose", "seed", "steps", "flat_lay")


def valid_id(call_id):
    return isinstance(call_id, str) and bool(CALL_ID.match(call_id))


def start_body(body):
    """("warm", None) for a wake-up, ("paint", request) for a picture, or ("invalid", None)."""
    if not isinstance(body, dict):
        return "invalid", None
    if body.get("warm"):
        return "warm", None
    request = {key: body[key] for key in FIELDS if key in body}
    if not isinstance(request.get("person"), str) or not isinstance(request.get("garment"), str):
        return "invalid", None
    return "paint", request


def finished(answer):
    """The paint method's answer as the result endpoint sends it: `status` added, and no picture when a
    check said no (the page keeps its own)."""
    answer = dict(answer) if isinstance(answer, dict) else {"ok": False, "error": "no_answer"}
    if not answer.get("ok"):
        answer.pop("image", None)
    answer["status"] = "done"
    return answer


def outcome(answer=None, error=None, phase="starting"):
    """(HTTP status, body) for one look at a call: FunctionCall.get(timeout=0) gave `answer`, or raised
    `error`. It raises the built-in TimeoutError while the call is queued or running (then `phase` says
    whether a GPU has started on it), Modal's OutputExpiredError once its result is gone (after 7 days), and
    the call's own failure otherwise (FunctionTimeoutError, a cancellation, a crash)."""
    if error is None:
        return 200, finished(answer)
    if isinstance(error, TimeoutError):
        return 202, {"status": "pending", "phase": phase if phase in ("starting", "painting") else "starting"}
    name = type(error).__name__
    if name == "OutputExpiredError":
        return 410, {"status": "failed", "error": "expired"}
    return 200, {"status": "failed", "error": "timeout" if name == "FunctionTimeoutError" else name}
