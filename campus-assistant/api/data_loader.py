"""
Parses js/data.js server-side (no Node.js dependency) to extract
CAMPUS_GROUPS, CAMPUS_LOCATIONS, and CAMPUS_OFFICES, then normalizes
every record into a consistent shape for embedding + retrieval.

This is a *tolerant* JS-object-literal parser, not a full JS engine.
It handles the specific shape used in data.js: double-quoted string
keys/values, arrays and objects, // and /* */ comments, trailing
commas, and `numbers`/`null`. It does NOT evaluate JS expressions
(e.g. `window.X = [...]` assignments) — it only extracts the array
literal itself.
"""

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


def _strip_comments(js: str) -> str:
    """Remove // line comments and /* */ block comments.

    Naive but safe here because none of the string *values* in this
    dataset contain '//' or '/*' — if that ever changes, this needs a
    proper tokenizer instead of regex stripping.
    """
    js = re.sub(r"/\*.*?\*/", "", js, flags=re.DOTALL)
    js = re.sub(r"//[^\n]*", "", js)
    return js


def _find_array_literal(js: str, var_name: str) -> str:
    """Find `var_name = [ ... ]` (possibly after `window.X =`) and
    return the raw text of the [...] array literal, using bracket
    counting so nested arrays/objects don't confuse it.
    """
    # Matches: const NAME = [   OR   var NAME = window.NAME = [
    pattern = re.compile(
        r"\b" + re.escape(var_name) + r"\s*=\s*(?:window\." + re.escape(var_name) + r"\s*=\s*)?\["
    )
    match = pattern.search(js)
    if not match:
        raise ValueError(f"Could not find array assignment for `{var_name}` in data.js")

    start = match.end() - 1  # index of the opening '['
    depth = 0
    in_string = False
    string_char = ""
    i = start
    while i < len(js):
        ch = js[i]
        if in_string:
            if ch == "\\":
                i += 2
                continue
            if ch == string_char:
                in_string = False
        else:
            if ch in ("'", '"'):
                in_string = True
                string_char = ch
            elif ch == "[":
                depth += 1
            elif ch == "]":
                depth -= 1
                if depth == 0:
                    return js[start : i + 1]
        i += 1
    raise ValueError(f"Unbalanced brackets while parsing `{var_name}`")


def _js_array_to_json(js_array_text: str) -> Any:
    """Convert a JS array-literal string into parseable JSON text."""
    text = js_array_text

    # Quote unquoted object keys: `id:` -> `"id":`
    # Only matches keys immediately after `{` or `,` (with whitespace/newlines),
    # so it won't touch things like URLs (`https://...`) or string contents.
    text = re.sub(
        r'([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)\s*:',
        r'\1"\2":',
        text,
    )

    # Normalize single-quoted strings to double-quoted (data.js uses
    # double quotes already, but be defensive for future edits).
    def _single_to_double(m: "re.Match[str]") -> str:
        inner = m.group(1).replace('"', '\\"')
        return f'"{inner}"'

    text = re.sub(r"'((?:[^'\\]|\\.)*)'", _single_to_double, text)

    # Remove trailing commas before ] or }
    text = re.sub(r",\s*([\]}])", r"\1", text)

    return json.loads(text)


def load_raw_data(data_js_path: str | Path) -> dict[str, list[dict]]:
    """Load and parse CAMPUS_GROUPS, CAMPUS_LOCATIONS, CAMPUS_OFFICES
    straight out of the given data.js file.
    """
    raw = Path(data_js_path).read_text(encoding="utf-8")
    raw = _strip_comments(raw)

    groups = _js_array_to_json(_find_array_literal(raw, "CAMPUS_GROUPS"))
    locations = _js_array_to_json(_find_array_literal(raw, "CAMPUS_LOCATIONS"))
    offices = _js_array_to_json(_find_array_literal(raw, "CAMPUS_OFFICES"))

    return {"groups": groups, "locations": locations, "offices": offices}


@dataclass
class Record:
    """A normalized, embeddable record — one per group/location/office."""

    id: str
    name: str
    kind: str  # "group" | "location" | "office"
    category: str | None
    blob: str  # combined text used for embedding
    context: dict = field(default_factory=dict)  # fields shown to the LLM


def _blob(*parts: Any) -> str:
    """Join meaningful fields into one text blob, skipping empty values."""
    out = []
    for p in parts:
        if not p:
            continue
        if isinstance(p, (list, tuple)):
            joined = ", ".join(str(x) for x in p if x)
            if joined:
                out.append(joined)
        else:
            out.append(str(p))
    return ". ".join(out)


def normalize(raw: dict[str, list[dict]]) -> list[Record]:
    records: list[Record] = []

    # Map block id to friendly name if present in locations
    loc_id_to_name = {
        loc["id"]: loc.get("name", loc["id"])
        for loc in raw.get("locations", [])
        if "id" in loc
    }

    for g in raw["groups"]:
        blocks_raw = g.get("blocks", [])
        blocks_formatted = [
            loc_id_to_name.get(b, b.replace("block-", "Block "))
            for b in blocks_raw
        ]
        blocks_str = ", ".join(blocks_formatted) if blocks_formatted else None

        records.append(
            Record(
                id=g["id"],
                name=g.get("name", ""),
                kind="group",
                category=g.get("category"),
                blob=_blob(g.get("name"), g.get("type"), g.get("desc"), g.get("tags"), blocks_formatted),
                context={
                    "name": g.get("name"),
                    "type": g.get("type"),
                    "desc": g.get("desc"),
                    "category": g.get("category"),
                    "blocks": blocks_str,
                },
            )
        )

    for loc_list, kind in ((raw["locations"], "location"), (raw["offices"], "office")):
        for loc in loc_list:
            records.append(
                Record(
                    id=loc["id"],
                    name=loc.get("name", ""),
                    kind=kind,
                    category=loc.get("category"),
                    blob=_blob(
                        loc.get("name"),
                        loc.get("type"),
                        loc.get("desc"),
                        loc.get("facilities"),
                        loc.get("tags"),
                        loc.get("groupName"),
                    ),
                    context={
                        "name": loc.get("name"),
                        "type": loc.get("type"),
                        "desc": loc.get("desc"),
                        "facilities": loc.get("facilities"),
                        "hours": loc.get("hours"),
                        "phone": loc.get("phone"),
                        "floor": loc.get("floor"),
                        "groupName": loc.get("groupName"),
                        "category": loc.get("category"),
                    },
                )
            )

    return records


def load_records(data_js_path: str | Path) -> list[Record]:
    return normalize(load_raw_data(data_js_path))


if __name__ == "__main__":
    # Quick manual check: `python data_loader.py ../js/data.js`
    import sys

    path = sys.argv[1] if len(sys.argv) > 1 else "../js/data.js"
    recs = load_records(path)
    print(f"Parsed {len(recs)} records\n")
    for r in recs:
        print(f"[{r.kind:9}] {r.id:30} -> {r.blob[:90]}")
