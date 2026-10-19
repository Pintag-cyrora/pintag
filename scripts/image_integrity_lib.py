# Pure classification logic for scripts/image-integrity.py (no DB, no I/O) so it can be unit-tested.
#
# The question it answers: for every object in the `property-images` bucket that has NO property_images
# registry row, is that object accounted for by something legitimate, or is it genuinely orphaned?
#
# HOW IMAGES ARE REPRESENTED (all verified against the code that writes them):
#   * original gallery photo   properties.images (jsonb array of full public URLs) -> trigger -> property_images
#                              .storage_path = everything after "/property-images/" (not URL-decoded).
#   * unit-type photo          unit_types.images (text[] of full public URLs). NOT in the registry: the sync
#                              trigger only watches properties.images (docs/IMAGE_DR_RUNBOOK.md, "Remaining risks").
#   * agent photo              parties.photo_url (agent-setup.html uploads to agents/<id>/<ts>.<ext> in this bucket).
#   * delivery rendition       renditions/<stem>/<profile>.webp, <stem> = original object name minus its LAST
#                              extension (image-renditions.js renditionStem/renditionPath). Never registered.
#
# A rendition is ACCOUNTED FOR only when its original is referenced by a legitimate source that is live today
# (an active registry row, properties.images, unit_types.images or parties.photo_url). Renditions whose original
# is missing, removed from its gallery, or referenced by nothing are reported as ORPHANED and fail the check.

import re

PROFILES = ("thumbnail", "card", "gallery", "hero")
RENDITION_PREFIX = "renditions/"
RENDITION_RE = re.compile(r"^renditions/(.+)/(" + "|".join(PROFILES) + r")\.webp$")
_EXT_RE = re.compile(r"\.[A-Za-z0-9]+$")
_PUB_MARK = "/property-images/"

# category -> (label, fails_the_check)
CATEGORIES = {
    "rendition_ok":            ("Renditions of referenced originals (accounted for)", False),
    "unit_image_unregistered": ("Unit-type images not in the registry (known gap)",   False),
    "agent_photo":             ("Agent photos referenced by parties.photo_url",         False),
    "orphan_rendition":        ("ORPHANED renditions (original unreferenced/removed/missing)", True),
    "rendition_malformed":     ("ORPHANED rendition-folder objects with an unrecognised name", True),
    "listing_ref_unregistered": ("ORPHANED originals referenced by a listing but missing from the registry", True),
    "orphan_original":         ("ORPHANED originals (referenced by nothing)",           True),
}


def rendition_stem(name):
    """Mirror of image-renditions.js renditionStem(): drop query string, leading slashes, last extension."""
    if not name or not isinstance(name, str):
        return None
    clean = name.split("?")[0].lstrip("/")
    if not clean:
        return None
    return _EXT_RE.sub("", clean)


def parse_rendition(name):
    """(stem, profile) for a well-formed rendition object name, else None."""
    m = RENDITION_RE.match(name or "")
    return (m.group(1), m.group(2)) if m else None


def name_from_url(url):
    """Object name inside the bucket for one of OUR public property-images URLs (no URL-decoding, query removed,
    same extraction as the registry migration and backfill-renditions.mjs). None for external URLs."""
    if not url or not isinstance(url, str) or _PUB_MARK not in url:
        return None
    name = re.sub(r"^.*" + _PUB_MARK, "", url, count=1).split("?")[0]   # greedy, like the migration's regexp_replace
    return name or None


def _stems(names):
    out = set()
    for n in names:
        if n and not n.startswith(RENDITION_PREFIX):          # never derive a stem from a rendition
            s = rendition_stem(n)
            if s:
                out.add(s)
    return out


def classify(objects, registry_all, registry_active, listing_refs, unit_refs, agent_refs):
    """Split the unmapped storage objects into the categories above.

    objects          names of every object in the bucket
    registry_all     storage_path of every property_images row, ANY status (an object with a row is mapped)
    registry_active  storage_path of status='active' rows
    listing_refs     object names referenced by properties.images
    unit_refs        object names referenced by unit_types.images
    agent_refs       object names referenced by parties.photo_url
    Returns {"mapped": n, "unmapped": n, "categories": {cat: [names]}, "reasons": {name: why}} (names sorted).
    """
    objects = set(objects)
    reg_all, reg_active = set(registry_all), set(registry_active)
    listing, units, agents = set(listing_refs), set(unit_refs), set(agent_refs)

    live_stems = _stems(reg_active | listing | units | agents)
    history_stems = _stems(reg_all)
    storage_stems = _stems(objects)

    cats = {k: [] for k in CATEGORIES}
    reasons = {}
    mapped = 0
    for o in sorted(objects):
        if o in reg_all:
            mapped += 1
            continue
        if o.startswith(RENDITION_PREFIX):
            parsed = parse_rendition(o)
            if not parsed:
                cats["rendition_malformed"].append(o)
                reasons[o] = "not renditions/<stem>/{%s}.webp" % ",".join(PROFILES)
            elif parsed[0] in live_stems:
                cats["rendition_ok"].append(o)
            else:
                cats["orphan_rendition"].append(o)
                stem = parsed[0]
                if stem in history_stems:
                    reasons[o] = "original was removed from its gallery (registry row not active)"
                elif stem in storage_stems:
                    reasons[o] = "original exists in storage but nothing references it"
                else:
                    reasons[o] = "original not found in storage or any reference"
        elif o in units:
            cats["unit_image_unregistered"].append(o)
        elif o in agents:
            cats["agent_photo"].append(o)
        elif o in listing:
            cats["listing_ref_unregistered"].append(o)
            reasons[o] = "in properties.images but no property_images row (registry trigger drift)"
        else:
            cats["orphan_original"].append(o)
    unmapped = sum(len(v) for v in cats.values())
    return {"mapped": mapped, "unmapped": unmapped, "categories": cats, "reasons": reasons}


def failing_count(result, fail_on_unit_images=False):
    n = sum(len(result["categories"][k]) for k, (_, fails) in CATEGORIES.items() if fails)
    if fail_on_unit_images:
        n += len(result["categories"]["unit_image_unregistered"])
    return n


def format_breakdown(result, samples=5, fail_on_unit_images=False):
    """Report lines: count per category plus up to `samples` representative object names (public storage
    paths only — nothing from the connection string or the database is ever included)."""
    lines = [f'Unmapped objects (no registry row): {result["unmapped"]:,}']
    for key, (label, fails) in CATEGORIES.items():
        names = result["categories"][key]
        flag = " [FAILS]" if (fails or (fail_on_unit_images and key == "unit_image_unregistered")) else ""
        lines.append(f"  {label}: {len(names):,}{flag}")
        for n in names[:samples]:
            why = result["reasons"].get(n)
            lines.append(f"      {n}" + (f"   <- {why}" if why else ""))
        if len(names) > samples:
            lines.append(f"      … and {len(names) - samples:,} more")
    return lines
