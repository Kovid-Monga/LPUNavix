"""

api/data_loader.py — Direct, Safe Campus Data Loader for LPUNavix

==================================================================

Treats js/data.js as the SINGLE SOURCE OF TRUTH.

Safely extracts and parses campus collections without arbitrary code execution (no eval).

Preserves source collection, source ID, and all original fields for every record.

Provides deterministic filtering for exact queries, counts, block lookups,

and campus relationships. Zero runtime dependence on Knowledge Graph.

"""



import json

import logging

import math

import os

import re

from dataclasses import dataclass, field

from pathlib import Path

from typing import Any, Dict, List, Optional, Tuple, Union



logger = logging.getLogger("LPUNavix.DataLoader")

logger.setLevel(logging.INFO)



DATA_JS_PATH = Path(__file__).resolve().parent.parent / "js" / "data.js"





def safe_js_array_to_json(js_code: str) -> str:

    """

    Converts a JavaScript array literal into valid JSON without evaluating code:

    1. Removes single-line comments (// ...)

    2. Removes multi-line comments (/* ... */)

    3. Quotes unquoted object keys ({ id: -> { "id": )

    4. Strips trailing commas before closing braces/brackets (,} -> })

    """

    # 1. Single-line comments

    s = re.sub(r'//.*$', '', js_code, flags=re.MULTILINE)

    # 2. Multi-line comments

    s = re.sub(r'/\*.*?\*/', '', s, flags=re.DOTALL)

    # 3. Quote unquoted object keys

    s = re.sub(r'(?<=[{,])\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:', r'"\1":', s)

    # 4. Trailing commas before } or ]

    s = re.sub(r',\s*([}\]])', r'\1', s)

    return s.strip()





def haversine_distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:

    """Calculates Haversine distance in meters between two lat/lng pairs."""

    r = 6371000.0  # Earth radius in meters

    phi1 = math.radians(lat1)

    phi2 = math.radians(lat2)

    delta_phi = math.radians(lat2 - lat1)

    delta_lambda = math.radians(lon2 - lon1)

    a = (math.sin(delta_phi / 2.0) ** 2 +

         math.cos(phi1) * math.cos(phi2) * (math.sin(delta_lambda / 2.0) ** 2))

    return 2.0 * r * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))





@dataclass

class Record:

    """A normalized, embeddable record — one per group/location/office/connection."""



    id: str

    name: str

    kind: str  # "group" | "location" | "office" | "connection"

    category: Optional[str]

    blob: str  # combined text used for embedding

    context: dict = field(default_factory=dict)  # fields shown to the LLM

    uid: Optional[str] = None

    designation: Optional[str] = None

    responsibility: Optional[str] = None

    role: Optional[str] = None

    department_or_subject: Optional[str] = None

    block: Optional[str] = None

    room: Optional[str] = None

    seating: Optional[str] = None

    office: Optional[str] = None

    location_notation: Optional[str] = None

    parent_block_id: Optional[str] = None





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





def normalize(raw: Dict[str, List[Dict[str, Any]]]) -> List[Record]:

    records: List[Record] = []



    # Map block id to friendly name if present in locations

    loc_id_to_name = {

        loc["id"]: loc.get("name", loc["id"])

        for loc in raw.get("locations", [])

        if "id" in loc

    }



    for g in raw.get("groups", []):

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



    for loc_list, kind in (

        (raw.get("locations", []), "location"),

        (raw.get("offices", []), "office"),

        (raw.get("persons", []), "office"),

    ):

        for loc in loc_list:

            is_personnel = bool(loc.get("uid") or loc.get("role") or loc.get("responsibility"))

            parent_block_id = loc.get("parentBlockIds", [None])[0] if loc.get("parentBlockIds") else None



            ctx = {

                "name": loc.get("name"),

                "type": loc.get("type"),

                "desc": loc.get("desc"),

                "facilities": loc.get("facilities"),

                "hours": loc.get("hours"),

                "phone": loc.get("phone"),

                "floor": loc.get("floor"),

                "groupName": loc.get("groupName"),

                "category": loc.get("category"),

            }



            if is_personnel:

                if loc.get("uid"):

                    ctx["uid"] = str(loc.get("uid"))

                if loc.get("designation"):

                    ctx["designation"] = loc.get("designation")

                if loc.get("role") or loc.get("responsibility"):

                    ctx["role"] = loc.get("role") or loc.get("responsibility")

                    ctx["responsibility"] = loc.get("responsibility") or loc.get("role")

                if loc.get("department_or_subject"):

                    ctx["department_or_subject"] = loc.get("department_or_subject")

                if loc.get("block"):

                    ctx["block"] = str(loc.get("block"))

                if loc.get("room"):

                    ctx["room"] = str(loc.get("room"))

                if loc.get("seating"):

                    ctx["seating"] = str(loc.get("seating"))

                if loc.get("office"):

                    ctx["office"] = loc.get("office")

                if loc.get("location_notation"):

                    ctx["location_notation"] = loc.get("location_notation")

                if parent_block_id:

                    ctx["parentBlockId"] = parent_block_id



            blob_parts = [

                loc.get("name"),

                f"UID {loc.get('uid')}" if loc.get("uid") else None,

                loc.get("designation"),

                loc.get("responsibility"),

                loc.get("role"),

                loc.get("department_or_subject"),

                f"HOD of {loc.get('department_or_subject')}" if loc.get("department_or_subject") else None,

                f"Block {loc.get('block')}" if loc.get("block") else None,

                f"Room {loc.get('room')}" if loc.get("room") else None,

                f"Cabin {loc.get('seating')}" if loc.get("seating") else None,

                loc.get("office"),

                loc.get("location_notation"),

                loc.get("type"),

                loc.get("desc"),

                loc.get("facilities"),

                loc.get("tags"),

                loc.get("groupName"),

            ]



            records.append(

                Record(

                    id=loc["id"],

                    name=loc.get("name", ""),

                    kind=kind,

                    category=loc.get("category"),

                    blob=_blob(*blob_parts),

                    context=ctx,

                    uid=str(loc.get("uid")) if loc.get("uid") else None,

                    designation=loc.get("designation"),

                    responsibility=loc.get("responsibility"),

                    role=loc.get("role"),

                    department_or_subject=loc.get("department_or_subject"),

                    block=str(loc.get("block")) if loc.get("block") else None,

                    room=str(loc.get("room")) if loc.get("room") else None,

                    seating=str(loc.get("seating")) if loc.get("seating") else None,

                    office=loc.get("office"),

                    location_notation=loc.get("location_notation"),

                    parent_block_id=parent_block_id,

                )

            )



    for conn in raw.get("connections", []):

        blocks = conn.get("blocks", [])

        if not blocks and (conn.get("fromBlock") or conn.get("from")):

            f_b = conn.get("fromBlock") or conn.get("from")

            t_b = conn.get("toBlock") or conn.get("to")

            blocks = [b for b in (f_b, t_b) if b]



        blocks_str = " & ".join(blocks)

        name = conn.get("name") or (f"{blocks_str} Connection" if blocks_str else conn.get("id", "Block Connection"))

        how = conn.get("how") or conn.get("desc") or conn.get("description") or ""



        blob_parts = [

            name,

            *blocks,

            how,

            "connected",

            "connection",

            "bridge",

            "corridor",

            "walkway",

        ]



        records.append(

            Record(

                id=conn["id"],

                name=name,

                kind="connection",

                category="connection",

                blob=_blob(*blob_parts),

                context={

                    "name": name,

                    "type": "Block Connection",

                    "blocks": ", ".join(blocks),

                    "how": how,

                },

            )

        )



    return records





class CampusDataLoader:

    def __init__(self, data_js_path: Optional[Path] = None):

        self.data_js_path = data_js_path or DATA_JS_PATH

        self.campus_center: List[float] = [31.2536, 75.7037]

        self.groups: List[Dict[str, Any]] = []

        self.locations: List[Dict[str, Any]] = []

        self.offices: List[Dict[str, Any]] = []

        self.persons: List[Dict[str, Any]] = []

        self.connections: List[Dict[str, Any]] = []

        self.raw_data: Dict[str, List[Dict[str, Any]]] = {}

        self.records: List[Record] = []

        self._load_data()



    def _load_data(self):

        """Safely loads and indexes all collections directly from data.js."""

        if not self.data_js_path.exists():

            raise FileNotFoundError(f"data.js not found at {self.data_js_path}")



        with open(self.data_js_path, "r", encoding="utf-8") as f:

            text = f.read()



        varnames = [

            "CAMPUS_CENTER",

            "CAMPUS_GROUPS",

            "CAMPUS_LOCATIONS",

            "CAMPUS_OFFICES",

            "CAMPUS_PERSONS",

            "CAMPUS_BLOCK_CONNECTIONS"

        ]



        extracted: Dict[str, Any] = {}

        for varname in varnames:

            m = re.search(

                r'(?:const|var)\s+' + varname + r'\s*(?:=\s*window\.' + varname + r')?\s*=\s*(\[.*?\]);',

                text,

                re.DOTALL

            )

            if m:

                json_str = safe_js_array_to_json(m.group(1))

                extracted[varname] = json.loads(json_str)

            else:

                logger.warning(f"[DataLoader] Variable {varname} could not be extracted from data.js")

                extracted[varname] = []



        self.campus_center = extracted.get("CAMPUS_CENTER", [31.2536, 75.7037])

        self.groups = extracted.get("CAMPUS_GROUPS", [])

        self.locations = extracted.get("CAMPUS_LOCATIONS", [])

        self.offices = extracted.get("CAMPUS_OFFICES", [])

        self.persons = extracted.get("CAMPUS_PERSONS", [])

        self.connections = extracted.get("CAMPUS_BLOCK_CONNECTIONS", [])



        # Tag every record with its source collection & ID for strict provenance

        for g in self.groups:

            g["source_collection"] = "CAMPUS_GROUPS"

            g["source_id"] = g.get("id", "")

        for loc in self.locations:

            loc["source_collection"] = "CAMPUS_LOCATIONS"

            loc["source_id"] = loc.get("id", "")

        for off in self.offices:

            off["source_collection"] = "CAMPUS_OFFICES"

            off["source_id"] = off.get("id", "")

        for p in self.persons:

            p["source_collection"] = "CAMPUS_PERSONS"

            p["source_id"] = p.get("id", "")

        for conn in self.connections:

            conn["source_collection"] = "CAMPUS_BLOCK_CONNECTIONS"

            conn["source_id"] = conn.get("id", "")



        # Fast in-memory lookup maps

        self._index_records()

        self.raw_data = {

            "groups": self.groups,

            "locations": self.locations,

            "offices": self.offices,

            "persons": self.persons,

            "connections": self.connections,

        }

        self.records = normalize(self.raw_data)

        logger.info(

            f"[DataLoader] Successfully loaded from {self.data_js_path.name}: "

            f"{len(self.groups)} groups, {len(self.locations)} locations, "

            f"{len(self.offices)} offices, {len(self.persons)} persons, "

            f"{len(self.connections)} connections, {len(self.records)} normalized records."

        )



    def _index_records(self):

        # 1. Blocks map by ID, clean number, and name

        self.blocks_by_number: Dict[str, Dict[str, Any]] = {}

        self.blocks_by_id: Dict[str, Dict[str, Any]] = {}

        for loc in self.locations:

            loc_id = loc.get("id", "")

            self.blocks_by_id[loc_id] = loc

            m = re.search(r"block[-_ ]*([0-9]+)", loc_id)

            if m:

                self.blocks_by_number[m.group(1)] = loc

            # Also check name: e.g. "Block 25 (CSE)"

            name_m = re.search(r"\bblock\s*([0-9]+)\b", loc.get("name", ""), re.I)

            if name_m:

                self.blocks_by_number[name_m.group(1)] = loc



        # 2. Persons map by UID, ID, and clean lowercase name

        self.persons_by_uid: Dict[str, Dict[str, Any]] = {}

        self.persons_by_id: Dict[str, Dict[str, Any]] = {}

        self.persons_by_name: Dict[str, Dict[str, Any]] = {}

        for p in self.persons:

            pid = p.get("id", "")

            uid = p.get("uid", "")

            name = p.get("name", "")

            self.persons_by_id[pid] = p

            if uid:

                self.persons_by_uid[uid] = p

            if name:

                self.persons_by_name[name.lower().strip()] = p



        # 3. Hostels map

        self.hostels: List[Dict[str, Any]] = [

            loc for loc in self.locations if loc.get("category") == "hostels"

        ]



    # -------------------------------------------------------------------------

    # Properties & Deterministic Helper Methods

    # -------------------------------------------------------------------------



    @property

    def facilities(self) -> List[Dict[str, Any]]:

        """Returns non-hostel amenity and academic facility locations from data.js."""

        return [loc for loc in self.locations if loc.get("category") != "hostels"]



    def count_campus_entities(self, entity_type: str, filter_key: Optional[str] = None, filter_val: Optional[str] = None) -> Dict[str, Any]:

        """

        Calculates exact counts directly from data.js arrays.

        Zero LLM inference, zero hallucination.

        """

        clean_type = entity_type.strip().lower()

        if clean_type in ["block", "blocks", "academic block", "academic blocks"]:

            # Count numbered block records only. Category=academics also contains

            # non-block places (for example the library), so it is not a safe proxy.

            blocks_by_id = {}

            for loc in self.locations:

                loc_id = str(loc.get("id", ""))

                name = str(loc.get("name", ""))

                if re.match(r"^block[-_]\d+(?:[-_]|$)", loc_id, re.I) or re.match(r"^block\s+\d+\b", name, re.I):

                    blocks_by_id[loc.get("id") or name] = loc

            blocks = list(blocks_by_id.values())

            if filter_key and filter_val:

                f_val_clean = str(filter_val).strip().lower()

                blocks = [

                    b for b in blocks

                    if f_val_clean in str(b.get(filter_key, "")).lower() or

                       f_val_clean in str(b.get("groupName", "")).lower() or

                       f_val_clean in str(b.get("groupId", "")).lower() or

                       f_val_clean in str(b.get("type", "")).lower() or

                       any(f_val_clean in str(t).lower() for t in b.get("tags", []))

                ]

            return {

                "entity": "block",

                "count": len(blocks),

                "items": [b.get("name") or b.get("id") for b in blocks],

                "summary": f"The campus data contains {len(blocks)} numbered block record{'s' if len(blocks) != 1 else ''}."

            }

        elif clean_type in ["hostel", "hostels", "residence", "residential"]:

            hostels = self.hostels

            if filter_key and filter_val:

                f_val_clean = str(filter_val).strip().lower()

                hostels = [

                    h for h in hostels

                    if f_val_clean in str(h.get(filter_key, "")).lower() or

                       any(f_val_clean in str(t).lower() for t in h.get("tags", []))

                ]

            return {

                "entity": "hostel",

                "count": len(hostels),

                "summary": f"The campus data contains {len(hostels)} hostel or residential records."

            }

        elif clean_type in ["person", "persons", "faculty", "staff", "leadership", "hod", "hods"]:

            persons = self.persons

            if clean_type in ["hod", "hods"]:

                persons = [p for p in persons if p.get("role") == "HOD"]

            elif filter_key and filter_val:

                f_val_clean = str(filter_val).strip().lower()

                persons = [

                    p for p in persons

                    if f_val_clean in str(p.get(filter_key, "")).lower()

                ]

            label = "HODs" if clean_type in ["hod", "hods"] else "faculty/officials"

            return {

                "entity": clean_type,

                "count": len(persons),

                "summary": f"There are {len(persons)} {label} officially recorded in the campus dataset."

            }

        else:

            return {"entity": clean_type, "count": 0, "summary": f"Entity type '{entity_type}' is not recognized in campus counts."}



    def get_block(self, query: str) -> Optional[Dict[str, Any]]:

        """

        Finds block record in data.js, attaches its real connections from

        CAMPUS_BLOCK_CONNECTIONS, and related offices/leadership.

        """

        q = query.strip().lower()

        m = re.search(r"\b(?:block[-_ ]*)?([0-9]+)\b", q)

        b_num = m.group(1) if m else q



        block = self.blocks_by_number.get(b_num) or self.blocks_by_id.get(q) or self.blocks_by_id.get(f"block-{b_num}")

        if not block:

            return None



        result = dict(block)

        # Match coordinates: [lat, lng]

        if "lat" in result and "lng" in result:

            result["coordinates"] = [result["lat"], result["lng"]]



        # Attach connections from CAMPUS_BLOCK_CONNECTIONS

        connected = []

        for conn in self.connections:

            blocks_in_conn = conn.get("blocks", [])

            if any(f"block {b_num}" == b.lower() or f"block-{b_num}" == b.lower() or b_num == b.lower() or f"block {b_num}" in b.lower() for b in blocks_in_conn):

                connected.append({"blocks": blocks_in_conn, "how": conn.get("how", "")})

        result["connected_walkways"] = connected



        # Attach leadership / HODs residing in this block

        residing = []

        for p in self.persons:

            if str(p.get("block", "")).lower() == b_num:

                residing.append({

                    "name": p.get("name", ""),

                    "role": p.get("role", ""),

                    "room": p.get("room", ""),

                    "seating": p.get("seating", ""),

                    "notation": p.get("location_notation", "")

                })

        result["residing_leadership"] = residing



        # Attach related offices

        related_offices = []

        for off in self.offices:

            parent_ids = [str(x).lower() for x in off.get("parentBlockIds", [])]

            if f"block-{b_num}" in parent_ids or block.get("id", "").lower() in parent_ids:

                related_offices.append(off)

        result["related_offices"] = related_offices



        # Attach related_records dictionary

        related_persons = [p for p in self.persons if str(p.get("block", "")).lower() == b_num]

        related_depts = []

        for g in self.groups:

            raw_blks = [str(x).lower() for x in g.get("blocks", [])]

            stripped_blks = [b.replace("block-", "") for b in raw_blks]

            if b_num in stripped_blks or f"block-{b_num}" in raw_blks:

                d = dict(g)

                d["blocks"] = list(dict.fromkeys(stripped_blks + raw_blks))

                related_depts.append(d)



        result["related_records"] = {

            "offices": related_offices,

            "persons": related_persons,

            "departments": related_depts,

            "facilities": []

        }



        return result



    def get_all_hods(self) -> List[Dict[str, Any]]:

        """Returns all 13 authentic HOD records directly from CAMPUS_PERSONS."""

        hods = [p for p in self.persons if p.get("role") == "HOD"]

        result = []

        for h in hods:

            result.append({

                "id": h.get("id"),

                "name": h.get("name"),

                "department": h.get("department_or_subject") or "CSE",

                "role": h.get("role"),

                "designation": h.get("designation"),

                "block": h.get("block"),

                "room": h.get("room"),

                "cabin": h.get("seating"),

                "location_notation": h.get("location_notation"),

                "hours": h.get("hours", "8:00 AM - 5:30 PM"),

                "coordinates": [h.get("lat"), h.get("lng")] if h.get("lat") and h.get("lng") else None,

                "source_collection": "CAMPUS_PERSONS",

                "source_id": h.get("id")

            })

        return result



    def get_hod(self, department_or_query: str) -> Optional[Dict[str, Any]]:

        """Finds official HOD record for department, specialization, or block."""

        raw_q = department_or_query.strip().lower()



        # If asking for all HODs, return None so get_all_hods handles it

        if re.search(r"\b(all\s+hods?|list\s+(?:of\s+)?(?:all\s+)?hods?|every\s+hod|who\s+are\s+(?:all\s+)?(?:the\s+)?hods?|hod\s+list)\b", raw_q):

            return None



        # Check if query mentions a block

        m_b = re.search(r"\bblock[-_ ]*([0-9]+)\b", raw_q)

        if m_b:

            # If it's not asking for who/hod/head/faculty/dean/in charge/cabin/meet, do NOT treat as HOD query

            if not re.search(r"\b(hod|head|dean|chairperson|coordinator|faculty|in charge|who|meet|reach|cabin)\b", raw_q):

                return None

            b_num = m_b.group(1)

            if b_num == "1":

                # Block 1 houses School of Fashion Design (NO HOD record in data.js)

                return {

                    "name": None,

                    "department": "School of Fashion Design",

                    "central_block": "1",

                    "location_notation": "Block 1",

                    "has_hod": False,

                    "message": "Block 1 houses the School of Fashion Design. No Head of Department (HOD) is listed in the campus records for this department."

                }

            # Check if an HOD has this block

            for p in self.persons:

                if p.get("role") == "HOD" and str(p.get("block", "")).lower() == b_num:

                    return {

                        "name": p.get("name"),

                        "department": p.get("department_or_subject"),

                        "role": p.get("role"),

                        "block": p.get("block"),

                        "room": p.get("room"),

                        "cabin": p.get("seating"),

                        "location_notation": p.get("location_notation"),

                        "has_hod": True,

                        "coordinates": [p.get("lat"), p.get("lng")] if p.get("lat") and p.get("lng") else None

                    }

            return None



        # Synonyms and Canonical Department Names

        synonyms = {

            "cse": "Data Science and Big Data",

            "computer science": "Data Science and Big Data",

            "data science": "Data Science and Big Data",

            "big data": "Data Science and Big Data",

            "ai": "Artificial Intelligence and Machine Learning",

            "ml": "Artificial Intelligence and Machine Learning",

            "aiml": "Artificial Intelligence and Machine Learning",

            "artificial intelligence": "Artificial Intelligence and Machine Learning",

            "machine learning": "Artificial Intelligence and Machine Learning",

            "cloud": "Cloud Computing",

            "cloud computing": "Cloud Computing",

            "cyber": "Network and Cyber Security",

            "security": "Network and Cyber Security",

            "cyber security": "Network and Cyber Security",

            "network and cyber security": "Network and Cyber Security",

            "network security": "Network and Cyber Security",

            "math": "Mathematics",

            "maths": "Mathematics",

            "mathematics": "Mathematics",

            "chemistry": "Chemistry",

            "ece": "ECE",

            "electronics": "ECE",

            "devops": "DevOps",

            "programming": "Programming",

            "coding": "Programming",

            "software testing": "Software Testing and Methodologies",

            "software testing and methodologies": "Software Testing and Methodologies",

            "full stack": "Full Stack Application Development",

            "full stack application development": "Full Stack Application Development",

            "fullstack": "Full Stack Application Development",

            "hol": "HOL",

            "academic operations": "Academic Operations",

        }

        for k, target_dept in synonyms.items():

            if re.search(r"\b" + re.escape(k) + r"\b", raw_q):

                for p in self.persons:

                    if p.get("role") == "HOD" and p.get("department_or_subject") == target_dept:

                        return {

                            "name": p.get("name"),

                            "department": p.get("department_or_subject"),

                            "role": p.get("role"),

                            "block": p.get("block"),

                            "room": p.get("room"),

                            "cabin": p.get("seating"),

                            "location_notation": p.get("location_notation"),

                            "hours": p.get("hours", "8:00 AM - 5:30 PM"),

                            "coordinates": [p.get("lat"), p.get("lng")] if p.get("lat") and p.get("lng") else None,

                            "has_hod": True

                        }



        # Check for School of Fashion Design

        if re.search(r"\b(fashion|fashion\s*design)\b", raw_q):

            return {

                "name": None,

                "department": "School of Fashion Design",

                "central_block": "1",

                "location_notation": "Block 1",

                "has_hod": False,

                "message": "The School of Fashion Design is located in Block 1. Please note that no specific Head of Department (HOD) is listed in the campus records for this department."

            }



        # Match department or division in CAMPUS_PERSONS where role == "HOD" with word boundaries

        STOPWORDS = {

            "who", "is", "the", "hod", "of", "for", "head", "department", "dept", "where",

            "what", "which", "me", "find", "locate", "can", "you", "know", "details",

            "info", "information", "please", "room", "cabin", "meet", "sir", "mam", "dr",

            "prof", "tell", "about", "block", "building", "give", "show", "contact", "person",

            "in", "at", "to", "a", "an", "i", "how", "and", "all", "your", "my", "their",

            "this", "that", "or", "with", "on", "by", "from", "not", "no", "any", "some",

            "previous", "instructions", "system", "prompt", "ignore", "are"

        }

        tokens = [tok for tok in re.findall(r"\b[a-zA-Z0-9]+\b", raw_q) if tok not in STOPWORDS and len(tok) > 2]

        if tokens:

            for p in self.persons:

                if p.get("role") != "HOD":

                    continue

                dept_words = set(re.findall(r"\b[a-zA-Z0-9]+\b", str(p.get("department_or_subject", "")).lower())) - STOPWORDS

                overlap = set(tokens) & dept_words

                # Require meaningful domain overlap (either at least 2 matching department words or a unique long token >= 5 chars)

                if len(overlap) >= 2 or any(len(w) >= 5 and w in dept_words for w in tokens):

                    return {

                        "name": p.get("name"),

                        "department": p.get("department_or_subject"),

                        "role": p.get("role"),

                        "block": p.get("block"),

                        "room": p.get("room"),

                        "cabin": p.get("seating"),

                        "location_notation": p.get("location_notation"),

                        "hours": p.get("hours", "8:00 AM - 5:30 PM"),

                        "coordinates": [p.get("lat"), p.get("lng")] if p.get("lat") and p.get("lng") else None,

                        "has_hod": True

                    }



        return None



    def get_person(self, query: str) -> Optional[Dict[str, Any]]:

        """Searches CAMPUS_PERSONS by name, UID, or cabin code notation."""

        clean_q = query.strip().lower()



        # 1. UID match

        m_uid = re.search(r"\b(\d{5})\b", clean_q)

        if m_uid:

            uid = m_uid.group(1)

            if uid in self.persons_by_uid:

                p = self.persons_by_uid[uid]

                return self._format_person(p)



        # 2. Notation match: e.g. "34-209-C1" or "34-209"

        m_not = re.search(r"\b(\d{2}-\d{3}(?:-[A-Za-z0-9]+)?)\b", clean_q)

        if m_not:

            notation = m_not.group(1).lower()

            for p in self.persons:

                if str(p.get("location_notation", "")).lower() == notation:

                    return self._format_person(p)



        # 3. Exact name match

        for name, p in self.persons_by_name.items():

            raw_name = re.sub(r"^(?:dr|mr|mrs|ms|prof)\.?\s*", "", name).strip()

            if raw_name and len(raw_name) >= 3 and re.search(r"\b" + re.escape(raw_name) + r"\b", clean_q):

                return self._format_person(p)

            if name in clean_q:

                return self._format_person(p)



        # 4. Token overlap & fuzzy name matching

        stopwords = {

            "dr", "prof", "mr", "mrs", "ms", "sir", "maam", "where", "is", "are",

            "cabin", "meet", "contact", "office", "room", "who", "the", "how", "what",

            "which", "and", "for", "does", "sit", "located", "find", "can", "tell",

            "about", "want", "like", "need", "go", "going", "to", "from", "at", "in", "on",

            "first", "start", "buy", "some", "gate", "main", "block", "reach", "way",

            "head", "get", "take", "would", "will", "shall", "could", "should", "me", "my",

            "but", "medics", "medicine", "medicines", "hospital", "clinic", "food", "eat", "study"

        }

        q_tokens = [t for t in re.findall(r"\b[a-z]{3,}\b", clean_q) if t not in stopwords]

        if q_tokens:

            best_p = None

            best_score = 0

            for p in self.persons:

                p_name = p.get("name", "").lower()

                p_words = [w for w in re.findall(r"\b[a-z]{3,}\b", p_name) if w not in stopwords]

                if not p_words:

                    continue

                score = 0

                for qt in q_tokens:

                    for pw in p_words:

                        if qt == pw:

                            score += 2

                        elif len(qt) >= 5 and len(pw) >= 5 and abs(len(qt) - len(pw)) <= 1:

                            if sum(1 for a, b in zip(qt, pw) if a == b) >= min(len(qt), len(pw)) - 1:

                                score += 1.5

                if score > best_score and score >= 2:

                    best_score = score

                    best_p = p



            if best_p:

                return self._format_person(best_p)



        return None



    def _format_person(self, p: Dict[str, Any]) -> Dict[str, Any]:

        return {

            "id": p.get("id"),

            "name": p.get("name"),

            "uid": p.get("uid"),

            "designation": p.get("designation"),

            "role": p.get("role"),

            "responsibility": p.get("responsibility"),

            "department": p.get("department_or_subject") or p.get("groupName"),

            "block": p.get("block"),

            "room": p.get("room"),

            "cabin": p.get("seating"),

            "office": p.get("office"),

            "location_notation": p.get("location_notation"),

            "hours": p.get("hours", "8:00 AM - 5:30 PM"),

            "coordinates": [p.get("lat"), p.get("lng")] if p.get("lat") and p.get("lng") else None,

            "facilities": p.get("facilities", []),

            "tags": p.get("tags", []),

            "desc": p.get("desc", ""),

            "source_collection": "CAMPUS_PERSONS",

            "source_id": p.get("id")

        }



    def get_hostel_info(self, query: str) -> Optional[Dict[str, Any]]:

        """Resolves boys/girls residential area or specific hostel from data.js."""

        clean = query.strip().lower()



        # 1. Boys residential area general query

        if re.search(r"\b(?:boys?\s*hostels?|boys?\s*accommodation|residential\s*area|boys?\s*residence)\b", clean):

            # Find residential-area group in CAMPUS_GROUPS

            group = next((g for g in self.groups if g.get("id") == "residential-area"), None)

            coords = group.get("centerCoords") if group else [31.249742, 75.703481]

            return {

                "id": "residential-area",

                "name": "Residential Area (Boys Hostels)",

                "type": "Residential Zone",

                "category": "hostels",

                "coordinates": coords,

                "desc": group.get("desc", "Main residential area housing Boys Hostels 1 to 6, Boys Studios, and Apartments.") if group else "Boys residential area.",

                "hours": "24 Hours (Gate Timings Apply)",

                "source_collection": "CAMPUS_GROUPS",

                "source_id": "residential-area"

            }



        # 2. Girls residential area general query

        if re.search(r"\b(?:girls?\s*hostels?|girls?\s*accommodation|girls?\s*residential\s*area|girls?\s*residence)\b", clean):

            group = next((g for g in self.groups if g.get("id") == "girls-residential-area"), None)

            coords = group.get("centerCoords") if group else [31.2568, 75.7049]

            return {

                "id": "girls-residential-area",

                "name": "Girls Residential Area",

                "type": "Residential Zone",

                "category": "hostels",

                "coordinates": coords,

                "desc": group.get("desc", "Residential area housing Girls Hostels (GH-1 to GH-4) and Girls Studios.") if group else "Girls residential area.",

                "hours": "24 Hours (Gate Timings Apply)",

                "source_collection": "CAMPUS_GROUPS",

                "source_id": "girls-residential-area"

            }



        # 3. Specific hostel (e.g. bh-1, gh-2, bs-11, apartment ab)

        for h in self.hostels:

            hid = h.get("id", "").lower()

            hname = h.get("name", "").lower()

            tags = [t.lower() for t in h.get("tags", [])]

            if hid in clean or hname in clean or any(t in clean for t in tags if len(t) > 2):

                return {

                    "id": h.get("id"),

                    "name": h.get("name"),

                    "type": h.get("type"),

                    "category": "hostels",

                    "coordinates": [h.get("lat"), h.get("lng")] if h.get("lat") and h.get("lng") else None,

                    "desc": h.get("desc"),

                    "facilities": h.get("facilities", []),

                    "hours": h.get("hours", "24 Hours (Gate Timings Apply)"),

                    "source_collection": "CAMPUS_LOCATIONS",

                    "source_id": h.get("id")

                }



        return None



    def find_lost_and_found(self) -> Optional[Dict[str, Any]]:

        """

        Retrieves the official Lost and Found office record from data.js.

        Ground truth: office-admin-28-209 in CAMPUS_OFFICES explicitly lists 'Lost and Found'.

        """

        for off in self.offices:

            facs = [str(f).lower() for f in off.get("facilities", [])]

            tags = [str(t).lower() for t in off.get("tags", [])]

            if any("lost" in f and "found" in f for f in facs) or any("lost" in t and "found" in t for t in tags):

                return {

                    "id": off.get("id"),

                    "name": off.get("name"),

                    "type": off.get("type"),

                    "floor": off.get("floor"),

                    "facilities": off.get("facilities"),

                    "desc": off.get("desc"),

                    "hours": off.get("hours"),

                    "coordinates": [off.get("lat"), off.get("lng")] if off.get("lat") and off.get("lng") else None,

                    "parentBlockIds": off.get("parentBlockIds", []),

                    "source_collection": "CAMPUS_OFFICES",

                    "source_id": off.get("id")

                }

        return None



    def find_stationery(self) -> List[Dict[str, Any]]:

        """Retrieves stationery tuck shops and UniMall from data.js."""

        results = []

        for off in self.offices:

            tags = [t.lower() for t in off.get("tags", [])]

            facs = [f.lower() for f in off.get("facilities", [])]

            if "stationery" in tags or any("stationery" in f or "pen" in f for f in facs):

                results.append({

                    "id": off.get("id"),

                    "name": off.get("name"),

                    "type": off.get("type"),

                    "floor": off.get("floor"),

                    "hours": off.get("hours"),

                    "coordinates": [off.get("lat"), off.get("lng")] if off.get("lat") and off.get("lng") else None,

                    "source_collection": "CAMPUS_OFFICES",

                    "source_id": off.get("id")

                })

        # Add UniMall

        unimall = next((loc for loc in self.locations if loc.get("id") == "unimall"), None)

        if unimall:

            results.append({

                "id": unimall.get("id"),

                "name": unimall.get("name"),

                "type": unimall.get("type"),

                "floor": unimall.get("floor"),

                "hours": unimall.get("hours"),

                "coordinates": [unimall.get("lat"), unimall.get("lng")] if unimall.get("lat") and unimall.get("lng") else None,

                "source_collection": "CAMPUS_LOCATIONS",

                "source_id": unimall.get("id")

            })

        return results



    def find_nearest_amenities(self, category: str, lat: float, lng: float, max_results: int = 2) -> List[Dict[str, Any]]:

        """Calculates nearest campus amenities using Haversine distance on data.js coordinates."""

        cat_clean = category.strip().lower()

        candidates = []

        for loc in self.locations:

            l_cat = str(loc.get("category", "")).lower()

            l_type = str(loc.get("type", "")).lower()

            l_tags = [t.lower() for t in loc.get("tags", [])]

            if cat_clean == l_cat or cat_clean in l_type or any(cat_clean in t for t in l_tags):

                if loc.get("lat") and loc.get("lng"):

                    d = haversine_distance_m(lat, lng, loc["lat"], loc["lng"])

                    candidates.append({

                        "name": loc.get("name"),

                        "category": loc.get("category"),

                        "distance_m": round(d),

                        "coordinates": [loc["lat"], loc["lng"]],

                        "desc": loc.get("desc", "")

                    })

        candidates.sort(key=lambda x: x["distance_m"])

        return candidates[:max_results]



    def get_corridor_connections(self, query: str = "") -> List[Dict[str, Any]]:

        """Filters connections matching query from CAMPUS_BLOCK_CONNECTIONS."""

        q = query.strip().lower()

        if not q:

            return self.connections

        results = []

        for conn in self.connections:

            blks = [str(b).lower() for b in conn.get("blocks", [])]

            if any(q in b for b in blks) or q in conn.get("how", "").lower():

                results.append(conn)

        return results



    def resolve_concept_intent(self, query: str) -> Optional[Dict[str, Any]]:

        """Resolves student needs (study, food, cash, doctor, project, print, computer) to data.js records."""

        q = query.strip().lower()

        concepts = [

            {"id": "concept_study", "name": "Study & Reading", "aliases": ["study", "reading", "read books", "quiet place", "exam prep", "self study", "place to study", "library", "books"]},

            {"id": "concept_food", "name": "Food & Dining", "aliases": ["food", "lunch", "dinner", "eat", "cafe", "restaurant", "snack", "hungry", "food court", "paneer", "dosa", "doss", "pizza", "burger", "meal", "breakfast", "dining", "grab", "canteen", "chai", "coffee", "beverage", "tea"]},

            {"id": "concept_cash", "name": "Cash & Banking", "aliases": ["cash", "atm", "atms", "money", "withdraw", "bank", "banking"]},

            {"id": "concept_sick", "name": "Healthcare & Medical", "aliases": ["sick", "doctor", "doctors", "fever", "ill", "headache", "vomit", "medicine", "first aid", "health center", "medical", "clinic", "hospital", "not feeling well", "not well", "feeling ill", "unwell", "dizzy", "hurt", "injured", "pain", "medics", "medicines", "pharmacy", "chemist", "blood", "blood test", "test blood", "blood tested", "checkup", "consultation", "treatment", "emergency"]},

            {"id": "concept_project", "name": "Project Guidance", "aliases": ["project", "capstone", "mentor", "project submission", "project guide"]},

            {"id": "concept_print", "name": "Printing & Stationery", "aliases": ["print", "printing", "photocopy", "xerox", "stationery", "pen", "pens", "pencil", "pencils", "notebook", "notebooks", "assignment print", "tuck shop", "tuckshop", "stationery shop"]},

            {"id": "concept_computing", "name": "Computer Labs & E-Library", "aliases": ["computer", "pc", "desktop", "coding lab", "programming lab", "use computer", "need computer"]},
            {"id": "concept_lost_found", "name": "Lost and Found Services", "aliases": ["lost and found", "lost property", "lost item", "lost items", "misplaced item", "found item", "found something", "lost something", "lost belongings", "lost pen", "lost wallet", "lost phone", "lost keys", "lost card", "lost id card", "report lost", "lost desk", "lost office"]}

        ]

        for c in concepts:

            for alias in c["aliases"]:

                if re.search(r"\b" + re.escape(alias) + r"\b", q):

                    return c

        return None





_data_loader_instance: Optional[CampusDataLoader] = None



def get_campus_data_loader() -> CampusDataLoader:

    """Singleton getter for CampusDataLoader."""

    global _data_loader_instance

    if _data_loader_instance is None:

        _data_loader_instance = CampusDataLoader()

    return _data_loader_instance





def load_raw_data(data_js_path: Optional[Union[str, Path]] = None) -> Dict[str, List[Dict[str, Any]]]:

    """Load raw campus collections straight out of the given data.js file."""

    loader = CampusDataLoader(Path(data_js_path) if data_js_path else None)

    return loader.raw_data





def load_records(data_js_path: Optional[Union[str, Path]] = None) -> List[Record]:

    """Load and normalize campus records into a flat list of Record dataclasses."""

    loader = CampusDataLoader(Path(data_js_path) if data_js_path else None)

    return loader.records

