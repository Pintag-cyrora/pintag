# Lao Brain — Metadata

Catalog and health-tracking for `brain/lao/`. Update this file whenever content in this directory is added, substantially revised, or reviewed — see `README.md` for what belongs where.

## Version

- Brain version: _placeholder — e.g. 0.1.0_

## Last updated

- Date: _placeholder_
- Updated by: _placeholder_

## Maintainer

- _placeholder — person/role responsible for keeping this directory accurate_

## Sources of truth

- _placeholder — which `knowledge-base/` files, founder input, or external references each section is grounded in_

## Confidence levels

- _placeholder — per-file or per-section: verified / founder-reviewed / draft / unverified_

## Review status

- _placeholder — per-file: not yet reviewed / in review / approved_

## Future notes

- **Relationship to `knowledge/` (the Knowledge/Intelligence Layer, `ARCHITECTURE.md` §5A):** `brain/lao/` is the seed of that layer's future Language module, not a separate system to reconcile. Phase 1 (current): `brain/lao/` stays exactly as-is, nothing is duplicated into `knowledge/`, and `knowledge/`'s `retrieveKnowledge()` reads `dictionary.md` transparently via a source adapter so callers never need to know it lives here rather than under `knowledge/language/`. Phase 2 (future, once that layer's schema has proven itself): a controlled migration into `knowledge/`, preserving every entry and this directory's richer per-term template. See `knowledge/README.md` → "Relationship to `brain/lao/`" for the full plan.
