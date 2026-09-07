"""
COZA Fashion — bridge between our Gemini photo tags and fashion-press.net's
coordinate-search taxonomy.

The "Kombin Arama" filters (item / color / material / pattern) are
fashion-press.net's own controlled vocabulary (see fashion_scraper.LOOKS_*).
Our per-photo tags come from gemini_client.tag_images, which returns loose
lowercase words ("denim", "leather", "black", "floral"). This module maps
each filter option value to the SET of Gemini words that should count as a
match, so /fashion/looks can be served from our own DB (FirstView included)
instead of live-proxying fashion-press.

Values here are compared against gemini_client._clean_tag output: already
lowercased and trimmed.
"""
from typing import Optional

# --- material: fashion-press value -> Gemini words -------------------------
_MATERIAL = {
    "denim": {"denim", "chambray"},
    "leather_suede": {"leather", "suede", "faux leather", "patent leather", "patent", "nubuck"},
    "fleece": {"fleece", "fleece", "fur", "faux fur", "shearling", "sherpa", "boa", "teddy"},
    "velvet": {"velvet", "velour"},
    "sheer": {"sheer", "tulle", "mesh", "organza", "chiffon", "lace", "net", "gauze"},
    "rubber": {"rubber", "pvc", "vinyl", "latex", "coated"},
    "knit": {"knit", "knitted", "knitwear", "crochet", "cashmere", "jersey", "ribbed"},
    "wool": {"wool", "tweed", "felt", "boucle", "flannel", "mohair", "cashmere wool"},
    "cotton": {"cotton", "linen", "canvas", "poplin", "twill", "denim cotton", "terry"},
    "nylon": {"nylon", "polyester", "synthetic", "technical", "taffeta", "ripstop", "shell"},
    "corduroy": {"corduroy", "cord"},
    "silk": {"silk", "satin", "silk satin", "charmeuse", "crepe", "georgette"},
    "feather": {"feather", "feathers", "plume", "ostrich"},
}

# --- color: fashion-press value -> Gemini words ---------------------------
_COLOR = {
    "white": {"white", "off-white", "off white"},
    "silver": {"silver", "metallic silver", "metallic", "chrome"},
    "grey": {"grey", "gray", "charcoal", "slate", "heather grey", "heather gray"},
    "black": {"black", "jet black"},
    "red": {"red", "scarlet", "crimson", "cherry"},
    "burgundy": {"burgundy", "maroon", "wine", "oxblood", "bordeaux"},
    "pink": {"pink", "rose", "fuchsia", "magenta", "blush", "hot pink", "salmon"},
    "purple": {"purple", "violet", "lavender", "lilac", "plum", "aubergine", "mauve"},
    "navy": {"navy", "dark blue", "midnight blue", "midnight"},
    "blue": {"blue", "cobalt", "royal blue", "azure", "electric blue"},
    "light_blue": {"light blue", "sky blue", "baby blue", "powder blue", "pale blue"},
    "green": {"green", "emerald", "forest green", "kelly green", "bottle green", "teal"},
    "olive": {"olive", "olive green", "army green"},
    "khaki": {"khaki", "tan"},
    "yellow": {"yellow", "lemon", "canary"},
    "mustard": {"mustard", "ochre", "amber"},
    "gold": {"gold", "golden", "metallic gold"},
    "orange": {"orange", "coral", "rust", "terracotta", "tangerine"},
    "beige": {"beige", "nude", "sand", "camel", "taupe", "stone", "oatmeal"},
    "ivory": {"ivory", "cream", "off-white", "off white", "eggshell"},
    "brown": {"brown", "chocolate", "coffee", "cognac", "espresso"},
}

# --- pattern: fashion-press value -> Gemini words -----------------------
_PATTERN = {
    "animal": {"animal print", "animal", "leopard", "zebra", "snake", "python", "cheetah", "tiger", "cow"},
    "floral": {"floral", "flower", "flowers", "botanical"},
    "dot": {"polka dot", "polka dots", "dotted", "dot", "dots", "spotted"},
    "stripes": {"striped", "stripe", "stripes", "pinstripe", "vertical stripe", "vertical stripes"},
    "border": {"horizontal stripe", "horizontal stripes", "breton", "border stripe"},
    "check": {"plaid", "check", "checked", "checks", "gingham", "tartan", "houndstooth", "windowpane", "checkerboard"},
    "camouflage": {"camouflage", "camo"},
    "geometric": {"geometric", "geometry", "op art"},
    "color_block": {"color block", "colorblock", "colour block", "colour-block", "color-block", "patchwork"},
    "gradient": {"gradient", "ombre", "tie-dye", "tie dye", "dip-dye", "dip dye", "degrade"},
    "paisley": {"paisley"},
    "nordic": {"nordic", "fair isle", "snowflake", "scandinavian"},
    "monogram": {"monogram", "logo print", "all-over logo", "all over logo"},
    "logo": {"logo", "text", "slogan", "lettering", "typography", "wording"},
    "graphic": {"graphic", "graphic print", "illustration", "artwork"},
    "heart": {"heart", "hearts"},
    "cross": {"cross", "crosses"},
    "print": {"print", "printed", "all-over print", "all over print", "conversational"},
    "abstract": {"abstract", "painterly", "brushstroke", "marble"},
    "solid": {"solid", "plain", "none", "no pattern", "unpatterned"},
    "one_spot": {"placement print", "single motif", "one spot", "chest print"},
}

# --- item: fashion-press value -> Gemini words -------------------------
# Gemini's item vocab is coarse (jacket/coat/dress/skirt/trousers/top...),
# so most fine fashion-press types fall back to their family. A few that
# Gemini does name specifically get a tighter set.
_ITEM_FAMILY = {
    # jackets
    **{k: {"jacket", "blazer"} for k in (
        "biker jacket", "bomber jacket", "collarless jacket", "double jacket",
        "field jacket", "shirt jacket", "stadium jumper", "tailored jacket",
        "track jacket", "work jacket",
    )},
    "puffer jacket": {"puffer", "puffer jacket", "down jacket", "quilted jacket", "jacket"},
    # tops
    "bustier": {"bustier", "corset", "top"},
    "camisole": {"camisole", "cami", "slip top", "top"},
    "cardigan": {"cardigan", "knit", "knitwear"},
    "hoodie": {"hoodie", "hooded sweatshirt", "sweatshirt"},
    "polo": {"polo", "polo shirt", "top"},
    "shirt": {"shirt", "blouse", "button-up", "button down"},
    "sweater": {"sweater", "jumper", "knit", "knitwear", "pullover"},
    "sweatshirt": {"sweatshirt", "crewneck"},
    "t shirt": {"t-shirt", "tee", "t shirt", "top"},
    "tank top": {"tank top", "tank", "vest top", "top"},
    "tube top": {"tube top", "bandeau", "strapless top", "top"},
    "tunic": {"tunic", "top"},
    "vest": {"vest", "waistcoat", "gilet"},
    # bottoms
    **{k: {"trousers", "pants"} for k in ("chino pants", "cropped pants", "jogger pants", "slacks")},
    "cargo pants": {"cargo pants", "cargo trousers", "trousers", "pants"},
    "denim pants": {"jeans", "denim pants", "denim", "trousers"},
    "shorts": {"shorts"},
    "mini skirt": {"mini skirt", "skirt"},
    "skirt": {"skirt", "maxi skirt", "midi skirt"},
    # dress / jumpsuit
    "formal dress": {"dress", "gown", "evening dress"},
    "one piece": {"dress", "one-piece", "one piece"},
    "jumpsuit": {"jumpsuit", "playsuit", "romper", "boilersuit"},
    "kimono": {"kimono", "robe"},
    # coats
    **{k: {"coat", "overcoat"} for k in (
        "chesterfield coat", "soutien collar coat", "stand collar coat", "wrap coat",
        "mods coat", "pea coat",
    )},
    "cape coat": {"cape", "cape coat", "poncho", "coat"},
    "duffle coat": {"duffle coat", "duffel coat", "coat"},
    "fur coat": {"fur coat", "faux fur coat", "shearling coat", "coat"},
    "military coat": {"military coat", "greatcoat", "coat"},
    "mountain parka": {"parka", "anorak", "coat"},
    "poncho coat": {"poncho", "cape", "coat"},
    "rain coat": {"raincoat", "rain coat", "mac", "trench coat", "coat"},
    "trench coat": {"trench coat", "trench", "coat"},
}

_FACETS = {"item": _ITEM_FAMILY, "color": _COLOR, "material": _MATERIAL, "pattern": _PATTERN}


def gemini_values_for(facet: str, value: str) -> "Optional[set]":
    """The Gemini words that count as a match for one filter option, or None
    if the facet/value is unknown (caller should then not filter on it)."""
    table = _FACETS.get(facet)
    if not table or not value:
        return None
    return table.get(value)


def tag_match_conditions(
    item: "Optional[str]" = None,
    color: "Optional[str]" = None,
    material: "Optional[str]" = None,
    pattern: "Optional[str]" = None,
) -> dict:
    """Mongo sub-document for `{"image_tags": {"$elemMatch": <this>}}` — the
    conditions a single photo's tag object must satisfy. Empty dict => no
    tag filtering requested (or none of the values were recognised)."""
    out: dict = {}
    for facet, raw in (("item", item), ("color", color), ("material", material), ("pattern", pattern)):
        vals = gemini_values_for(facet, raw) if raw else None
        if vals:
            out[facet] = {"$in": sorted(vals)}
    return out
