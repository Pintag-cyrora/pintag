# Lao Real Estate Dictionary

The entry point into the Lao Brain (see `README.md`). Entries are grouped by topic, not alphabetized — each group is a foundation the rest of `brain/lao/` builds on. Every entry follows the frozen template; see `README.md` for how agents should use this file and when to expand vs. split.

## Allowed Tags

### Property Type
`residential` `commercial` `industrial` `land`

### Transaction
`sale` `rent` `lease` `investment`

### Legal
`title` `ownership` `transfer` `tax` `boundary` `dispute`

### Audience
`buyer` `seller` `agent` `investor`

### Location
`district` `village`

### Language
`formal` `colloquial` `abbreviation`

### Marketing
`listing` `education` `negotiation`

Every entry's **Tags** field may only use values from this list. Adding a new tag means editing this section first, not inventing one inline in an entry.

---

## Land & Legal

### ໃບຕາດິນ

| Field | Content |
|---|---|
| **Lao term** | ໃບຕາດິນ — bai ta din |
| **Closest English Equivalent** | Land title / land ownership deed |
| **Definition** | The general, everyday Lao term for the official document a landowner holds as proof of land ownership. Used broadly to refer to "the land title" without specifying the exact legal document type or issuing authority. |
| **When to use** | Everyday conversation, listings, and educational content when referring generally to "the land title" a seller should be able to produce. |
| **When not to use** | When precision about the exact legal document type or issuing authority matters — this term is used loosely in speech and does not by itself confirm which specific legal document a seller holds. |
| **Common mistakes** | Treating ໃບຕາດິນ as confirmation of full, unrestricted ownership without checking which specific document the seller actually has. In practice, several different document types get casually referred to with this term, and buyers/agents don't always distinguish them precisely in conversation. The exact legal categories and how to tell them apart still need confirmation against Lao law before being stated as fact — see `land/title-types.md`. |
| **Example Usage** | "ລາວມີໃບຕາດິນຄົບຖ້ວນບໍ?" — "Does he/she have the complete land title documents?" |
| **Tags** | `land` `title` `legal` |
| **Source** | Common market usage |
| **Legal Verification** | Pending |
| **Status** | Draft |
| **Intent** | Define |

**Preferred Pintag Wording**
- Use "ໃບຕາດິນ" in educational articles when referring generally to land title documentation.
- Use "ໃບຕາດິນ" in property listings when confirming a property has title documentation.
- Avoid stating a specific title-type claim (e.g. naming a particular title category) unless that specific document type has actually been verified — see Common mistakes.

**Related Knowledge**
- `land/title-types.md`
- `land/ownership.md`
- `common-questions.md#how-do-i-verify-a-title`

---

### ສິດນຳໃຊ້ທີ່ດິນ

| Field | Content |
|---|---|
| **Lao term** | ສິດນຳໃຊ້ທີ່ດິນ — sit nam sai thi din |
| **Closest English Equivalent** | Right to use land / land-use right (sometimes rendered "usufruct right") |
| **Definition** | A term commonly used in the market to describe land documentation understood, in everyday practice, as distinct from full land title — generally referring to a right to use or occupy land rather than confirmed full ownership. This is how the term is used in common market practice; it is not presented here as a settled legal definition, and the underlying legal distinction from full title has not yet been verified against Lao law (see Legal Verification below). Referenced in Pintag's own buying guide as an alternative to full land title that a seller may hold instead — that guide is itself pending founder/legal review, not a confirmed legal source. |
| **When to use** | When a property's documentation is commonly described as a right-to-use certificate rather than full land title, or when explaining to buyers that Lao land documentation isn't a single uniform category — framed as market practice, not confirmed legal categorization. |
| **When not to use** | As a synonym for full land title (ໃບຕາດິນ) — they are commonly discussed as distinct categories in the market, and treating them as interchangeable risks misleading a buyer about what they're actually acquiring. Also avoid presenting the distinction itself as legally settled — it isn't, yet. |
| **Common mistakes** | Conflating this with ໃບຕາດິນ, or assuming it always carries the same rights and restrictions as full title. Do not state what those rights/restrictions specifically are as settled fact — the exact legal distinctions and implications between these categories require confirmation against Lao law before being stated definitively in published content. |
| **Example Usage** | "ເຮືອນຫຼັງນີ້ມີສິດນຳໃຊ້ທີ່ດິນ, ບໍ່ແມ່ນໃບຕາດິນເຕັມສ່ວນ." — "This house has land-use rights, not full land title." |
| **Tags** | `land` `title` `legal` |
| **Source** | Common market usage |
| **Legal Verification** | Pending |
| **Status** | Draft |
| **Intent** | Explain |

**Preferred Pintag Wording**
- Use "ສິດນຳໃຊ້ທີ່ດິນ" in educational articles when explicitly distinguishing this from full land title.
- Use "ສິດນຳໃຊ້ທີ່ດິນ" in property listings only when this is confirmed to be the actual documentation type for that property.
- Avoid using this term interchangeably with ໃບຕາດິນ — see When not to use.

**Related Knowledge**
- `land/title-types.md`
- `land/ownership.md`
- `#ໃບຕາດິນ`

---

### ໂອນ

| Field | Content |
|---|---|
| **Lao term** | ໂອນ — on |
| **Closest English Equivalent** | Transfer (of title/ownership) |
| **Definition** | The general Lao verb/noun for transferring ownership or title from one party to another — used broadly for the act of completing a property transaction's transfer step. |
| **When to use** | Describing the transfer step of a transaction in general terms (e.g. "ໂອນກໍາມະສິດ" — transfer ownership), in both spoken and written contexts. |
| **When not to use** | As a stand-in for the specific legal/administrative procedure required to register a transfer with the appropriate authority — ໂອນ names the action, not the procedural requirements, which vary and should not be assumed to be simple or uniform. |
| **Common mistakes** | Assuming ໂອນ alone implies the transfer is complete and registered. Completing an informal "ໂອນ" step (e.g. handshake, payment) is not the same as the transfer being legally registered with the appropriate authority — content should not conflate the two without confirming what registration actually requires. |
| **Example Usage** | "ພວກເຮົາຈະໂອນກໍາມະສິດອາທິດໜ້າ." — "We will transfer ownership next week." |
| **Tags** | `land` `transfer` `legal` |
| **Source** | Common market usage |
| **Legal Verification** | Pending |
| **Status** | Draft |
| **Intent** | Define |

**Preferred Pintag Wording**
- Use "ໂອນ" or "ໂອນກໍາມະສິດ" in educational articles when describing the general transfer step of a transaction.
- Use "ໂອນ" in listings/process descriptions when referring to the transfer stage.
- Avoid implying that "ໂອນ" alone means the transfer is legally finalized — see Common mistakes.

**Related Knowledge**
- `land/transfer.md`
- `legal-process.md`
- `#ໃບຕາດິນ`

---

## Property Listings

### ເຮືອນພ້ອມຢູ່

| Field | Content |
|---|---|
| **Lao term** | ເຮືອນພ້ອມຢູ່ — huan phom yu |
| **Closest English Equivalent** | Move-in ready house |
| **Definition** | A listing term describing a house that is ready for immediate occupancy — no renovation or additional work needed before a buyer or renter can move in. |
| **When to use** | Property listings and educational content describing a property's readiness for occupancy. |
| **When not to use** | For properties still under construction, needing renovation, or not yet finished to a livable standard — using this term for such properties overstates their actual condition. |
| **Common mistakes** | Using this term loosely to mean "furnished." ເຮືອນພ້ອມຢູ່ refers to move-in readiness generally (structurally and legally complete and habitable) — it does **not** automatically mean furniture, appliances, curtains, or décor are included. Any of those must be stated separately and explicitly; their absence from the listing text should be read as "not confirmed," not "included by default." |
| **Example Usage** | "ເຮືອນຫຼັງນີ້ເປັນເຮືອນພ້ອມຢູ່, ບໍ່ຕ້ອງສ້ອມແປງເພີ່ມ." — "This house is move-in ready; no further renovation is needed." |
| **Tags** | `residential` `listing` |
| **Source** | Common market usage |
| **Status** | Draft |
| **Intent** | Define |

**Preferred Pintag Wording**
- Use "ເຮືອນພ້ອມຢູ່" in property listings when a property is genuinely ready for immediate occupancy.
- Use "ເຮືອນພ້ອມຢູ່" in educational content explaining listing terminology to buyers.
- Avoid using this term to imply furniture, appliances, curtains, or décor are included — those must be confirmed and stated separately, never assumed from this term alone.

**Related Knowledge**
- `listings/overview.md`
- `buyer-journey.md`

---

### ຕິດຖະໜົນໃຫຍ່

| Field | Content |
|---|---|
| **Lao term** | ຕິດຖະໜົນໃຫຍ່ — tit thanon nyai |
| **Closest English Equivalent** | Fronting / adjacent to a main road |
| **Definition** | A listing descriptor indicating a property's frontage is directly on a main/major road, as opposed to being set back on a smaller lane or alley. |
| **When to use** | Property listings and educational content when a property genuinely has direct frontage on a main road — a commonly valued feature for commercial visibility or access. |
| **When not to use** | For properties accessed via a smaller side lane or alley, even if that lane eventually connects to a main road — this term specifically implies direct frontage, not proximity. |
| **Common mistakes** | Using this term for a property that is merely "near" a main road rather than directly fronting it. Proximity and direct frontage are treated as distinct claims in the market, and conflating them risks misleading buyers evaluating access or visibility for commercial use. |
| **Example Usage** | "ຮ້ານນີ້ຕິດຖະໜົນໃຫຍ່, ເໝາະສຳລັບເປີດຮ້ານຄ້າ." — "This shop fronts the main road, suitable for opening a storefront business." |
| **Tags** | `commercial` `residential` `listing` `land` |
| **Source** | Common market usage |
| **Status** | Draft |
| **Intent** | Define |

**Preferred Pintag Wording**
- Use "ຕິດຖະໜົນໃຫຍ່" in property listings only when the property has genuine direct main-road frontage.
- Use "ຕິດຖະໜົນໃຫຍ່" in educational content explaining listing terminology around access and frontage.
- Avoid this term when a property is merely near, not directly fronting, a main road — see Common mistakes.

**Related Knowledge**
- `listings/overview.md`
- `market/overview.md`

---

## Pricing & Negotiation

### ຂາຍດ່ວນ

| Field | Content |
|---|---|
| **Lao term** | ຂາຍດ່ວນ — khai duan |
| **Closest English Equivalent** | Urgent sale / quick sale |
| **Definition** | A listing term signaling that the seller wants to sell quickly, often implying openness to price negotiation or a faster transaction timeline — commonly used to attract buyer interest by signaling motivation. |
| **When to use** | Listings and marketing content where a seller has genuinely indicated urgency or motivation to sell quickly. |
| **When not to use** | As a routine marketing phrase applied to any listing regardless of actual seller motivation — per `brand-voice.md`'s rule against manufactured urgency, this term should only be used when there's a real, verifiable reason behind it, not as a generic attention-getting device. |
| **Common mistakes** | Overusing ຂາຍດ່ວນ as a default listing phrase rather than a genuine signal. This both erodes the term's credibility in the market and risks violating Pintag's own `posting-rules.md` ban on manufactured urgency/scarcity language. |
| **Example Usage** | "ຂາຍດ່ວນ! ເຈົ້າຂອງຈະຍົກຍ້າຍໄປຕ່າງແຂວງ." — "Urgent sale! The owner is relocating to another province." |
| **Tags** | `sale` `listing` `negotiation` |
| **Source** | Common market usage |
| **Status** | Draft |
| **Intent** | Warn |

**Preferred Pintag Wording**
- Use "ຂາຍດ່ວນ" in property listings only when there is a real, statable reason for urgency (e.g. relocation, per the example).
- Use "ຂາຍດ່ວນ" in educational articles as an example of language that requires real justification, per `brand-voice.md`.
- Avoid using "ຂາຍດ່ວນ" as a default/filler listing phrase — see Common mistakes.

**Related Knowledge**
- `negotiation.md`
- `market/overview.md`
- `forbidden-phrases.md`

---

### ລາຄາຕໍ່ລອງໄດ້

| Field | Content |
|---|---|
| **Lao term** | ລາຄາຕໍ່ລອງໄດ້ — lakha to long dai |
| **Closest English Equivalent** | Price negotiable |
| **Definition** | A listing term indicating the seller is open to negotiating the stated price — used to invite offers below or around the asking price. |
| **When to use** | Listings and content where a seller has genuinely indicated willingness to negotiate price and terms. |
| **When not to use** | As an assumed default for every listing — not every seller is open to negotiation, and stating this without confirmation misrepresents the seller's actual position. |
| **Common mistakes** | Assuming this phrase's presence or absence definitively signals a seller's flexibility. Negotiation is broadly standard practice in the Vientiane market regardless of whether a listing explicitly states ລາຄາຕໍ່ລອງໄດ້ — buyers shouldn't treat its absence as "no negotiation possible." |
| **Example Usage** | "ລາຄາຕໍ່ລອງໄດ້, ຕິດຕໍ່ເຈົ້າຂອງໂດຍກົງ." — "Price negotiable, contact the owner directly." |
| **Tags** | `sale` `rent` `negotiation` `listing` |
| **Source** | Common market usage |
| **Status** | Draft |
| **Intent** | Explain |

**Preferred Pintag Wording**
- Use "ລາຄາຕໍ່ລອງໄດ້" in property listings when the seller has confirmed openness to negotiation.
- Use "ລາຄາຕໍ່ລອງໄດ້" in educational articles explaining that negotiation is standard practice in this market.
- Avoid implying that its absence from a listing means a price is fixed — see Common mistakes.

**Related Knowledge**
- `negotiation.md`
- `market/overview.md`
- `#ຂາຍດ່ວນ`
