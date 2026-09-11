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

# --- free-text (COZA Lens search box): a typed word -> facet + Gemini words.
# Turkish first, common English too, so "pantolon" / "jean" / "yün ceket" /
# "siyah elbise" work as a search, not just the dropdown filters.
_FREETEXT = {
    # items
    "pantolon": {"item": {"trousers", "pants"}},
    "pantalon": {"item": {"trousers", "pants"}},
    "pants": {"item": {"trousers", "pants"}},
    "trousers": {"item": {"trousers", "pants"}},
    "jean": {"item": {"jeans", "denim"}, "material": {"denim"}},
    "jeans": {"item": {"jeans", "denim"}, "material": {"denim"}},
    "kot": {"item": {"jeans", "denim"}, "material": {"denim"}},
    "ceket": {"item": {"jacket", "blazer"}},
    "jacket": {"item": {"jacket", "blazer"}},
    "blazer": {"item": {"blazer", "jacket"}},
    "mont": {"item": {"coat", "puffer", "puffer jacket", "parka"}},
    "kaban": {"item": {"coat", "overcoat"}},
    "palto": {"item": {"coat", "overcoat"}},
    "coat": {"item": {"coat", "overcoat"}},
    "trench": {"item": {"trench coat", "trench"}},
    "trenchcoat": {"item": {"trench coat", "trench"}},
    "trenckot": {"item": {"trench coat", "trench"}},
    "elbise": {"item": {"dress", "gown"}},
    "dress": {"item": {"dress", "gown"}},
    "gown": {"item": {"gown", "dress", "evening dress"}},
    "abiye": {"item": {"gown", "evening dress", "dress"}},
    "etek": {"item": {"skirt", "mini skirt", "midi skirt", "maxi skirt"}},
    "skirt": {"item": {"skirt"}},
    "gomlek": {"item": {"shirt", "blouse"}},
    "shirt": {"item": {"shirt", "blouse"}},
    "bluz": {"item": {"blouse", "top"}},
    "blouse": {"item": {"blouse", "top"}},
    "kazak": {"item": {"sweater", "jumper", "knit", "pullover"}},
    "sweater": {"item": {"sweater", "jumper", "knit"}},
    "hirka": {"item": {"cardigan"}},
    "cardigan": {"item": {"cardigan"}},
    "tisort": {"item": {"t-shirt", "tee", "top"}},
    "tshirt": {"item": {"t-shirt", "tee", "top"}},
    "sort": {"item": {"shorts"}},
    "shorts": {"item": {"shorts"}},
    "tulum": {"item": {"jumpsuit", "romper", "playsuit"}},
    "jumpsuit": {"item": {"jumpsuit"}},
    "yelek": {"item": {"vest", "waistcoat", "gilet"}},
    "vest": {"item": {"vest", "waistcoat", "gilet"}},
    "hoodie": {"item": {"hoodie", "hooded sweatshirt"}},
    "kapusonlu": {"item": {"hoodie", "hooded sweatshirt"}},
    "takim": {"item": {"suit"}},
    "suit": {"item": {"suit"}},
    "top": {"item": {"top"}},
    "bustiyer": {"item": {"bustier", "corset", "top"}},
    "korse": {"item": {"corset", "bustier"}},
    "kimono": {"item": {"kimono", "robe"}},
    "pelerin": {"item": {"cape", "poncho"}},
    "cape": {"item": {"cape", "poncho"}},
    # colors
    "siyah": {"color": {"black", "jet black"}},
    "beyaz": {"color": {"white", "off-white", "off white"}},
    "kirmizi": {"color": {"red", "scarlet", "crimson"}},
    "mavi": {"color": {"blue", "cobalt", "royal blue"}},
    "lacivert": {"color": {"navy", "dark blue", "midnight blue"}},
    "yesil": {"color": {"green", "emerald", "forest green"}},
    "sari": {"color": {"yellow", "lemon"}},
    "pembe": {"color": {"pink", "rose", "fuchsia"}},
    "mor": {"color": {"purple", "violet", "lilac"}},
    "turuncu": {"color": {"orange", "coral"}},
    "gri": {"color": {"grey", "gray", "charcoal"}},
    "kahverengi": {"color": {"brown", "chocolate"}},
    "bej": {"color": {"beige", "nude", "sand", "camel"}},
    "krem": {"color": {"cream", "ivory"}},
    "bordo": {"color": {"burgundy", "maroon", "wine"}},
    "altin": {"color": {"gold", "golden"}},
    "gumus": {"color": {"silver", "metallic silver"}},
    "haki": {"color": {"khaki", "olive"}},
    "black": {"color": {"black"}},
    "white": {"color": {"white"}},
    "red": {"color": {"red"}},
    "blue": {"color": {"blue"}},
    "green": {"color": {"green"}},
    "pink": {"color": {"pink"}},
    "beige": {"color": {"beige"}},
    "brown": {"color": {"brown"}},
    "grey": {"color": {"grey", "gray"}},
    "gray": {"color": {"grey", "gray"}},
    "navy": {"color": {"navy"}},
    "gold": {"color": {"gold", "golden"}},
    # materials
    "deri": {"material": {"leather", "suede", "faux leather"}},
    "leather": {"material": {"leather", "suede"}},
    "suet": {"material": {"suede"}},
    "yun": {"material": {"wool", "tweed"}},
    "wool": {"material": {"wool", "tweed"}},
    "tuvit": {"material": {"tweed"}},
    "tweed": {"material": {"tweed"}},
    "pamuk": {"material": {"cotton", "linen"}},
    "cotton": {"material": {"cotton"}},
    "keten": {"material": {"linen"}},
    "linen": {"material": {"linen"}},
    "ipek": {"material": {"silk", "satin"}},
    "silk": {"material": {"silk", "satin"}},
    "saten": {"material": {"satin"}},
    "kadife": {"material": {"velvet", "velour"}},
    "velvet": {"material": {"velvet"}},
    "orgu": {"material": {"knit", "knitted", "knitwear", "crochet"}},
    "knit": {"material": {"knit", "knitwear"}},
    "triko": {"material": {"knit", "knitwear"}},
    "denim": {"material": {"denim"}, "item": {"jeans", "denim"}},
    "kurk": {"material": {"fur", "faux fur", "shearling"}},
    "fur": {"material": {"fur", "faux fur", "shearling"}},
    "tul": {"material": {"tulle", "sheer", "mesh"}},
    "dantel": {"material": {"lace", "sheer"}},
    "lace": {"material": {"lace"}},
    "naylon": {"material": {"nylon", "polyester"}},
    # patterns
    "cizgili": {"pattern": {"striped", "stripe", "stripes", "pinstripe"}},
    "striped": {"pattern": {"striped", "stripe", "stripes"}},
    "kareli": {"pattern": {"plaid", "check", "checked", "tartan", "gingham"}},
    "ekose": {"pattern": {"plaid", "tartan", "check"}},
    "plaid": {"pattern": {"plaid", "tartan", "check"}},
    "cicekli": {"pattern": {"floral", "flower", "flowers", "botanical"}},
    "floral": {"pattern": {"floral"}},
    "puantiyeli": {"pattern": {"polka dot", "polka dots", "dotted", "dots"}},
    "puantiye": {"pattern": {"polka dot", "polka dots", "dotted"}},
    "leopar": {"pattern": {"leopard", "animal print", "animal"}},
    "leopard": {"pattern": {"leopard", "animal print"}},
    "kamuflaj": {"pattern": {"camouflage", "camo"}},
    "camo": {"pattern": {"camouflage", "camo"}},
    "geometrik": {"pattern": {"geometric"}},
    "logolu": {"pattern": {"logo", "monogram", "logo print"}},
    "logo": {"pattern": {"logo", "monogram"}},
    "grafik": {"pattern": {"graphic", "graphic print"}},
    "baskili": {"pattern": {"print", "printed", "graphic"}},
    "duz": {"pattern": {"solid", "plain"}},
    "desensiz": {"pattern": {"solid", "plain"}},
}
# Turkish letters folded to ASCII so a query typed either way still hits.
_TR_FOLD = str.maketrans("çğıöşüÇĞİÖŞÜ", "cgiosuCGIOSU")


def free_text_conditions(q: str) -> dict:
    """Resolve a COZA Lens search string into per-facet tag-word conditions,
    e.g. {"item": {"$in": [...]}, "color": {"$in": [...]}}. Turkish letters
    are folded, single words are matched as tokens, multi-word terms against
    the whole string. Empty dict when nothing is recognised."""
    if not q or not q.strip():
        return {}
    ql = q.lower().translate(_TR_FOLD)
    tokens = set(re.findall(r"[a-z0-9]+", ql))
    acc: dict = {}
    for term, mapping in _FREETEXT.items():
        hit = (term in tokens) if " " not in term else (term in ql)
        if hit:
            for facet, words in mapping.items():
                acc.setdefault(facet, set()).update(words)
    return {facet: {"$in": sorted(words)} for facet, words in acc.items()}


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


# --------------------------------------------------------------------------
# B2: Turkish labels for raw Gemini tag words (for the trend-summary
# sentence, /fashion/trends). NOT the same vocabulary as fashion-press's
# LOOKS_* filter options above — Gemini's own words are looser/simpler
# (see gemini_client._TAG_SHAPE_RULES) — so this is its own small table
# rather than reusing looks_filters(). Anything not listed here falls back
# to a title-cased version of the English word (see tag_label_tr).
_TAG_LABELS_TR = {
    "item": {
        "dress": "elbise", "coat": "palto", "suit": "takım elbise", "skirt": "etek",
        "trousers": "pantolon", "pants": "pantolon", "jacket": "ceket", "blouse": "bluz",
        "jumpsuit": "tulum", "shirt": "gömlek", "t-shirt": "tişört", "sweater": "kazak",
        "coat dress": "palto elbise", "shorts": "şort", "vest": "yelek", "cardigan": "hırka",
    },
    "color": {
        "black": "siyah", "white": "beyaz", "red": "kırmızı", "beige": "bej",
        "navy": "lacivert", "multicolor": "çok renkli", "grey": "gri", "gray": "gri",
        "pink": "pembe", "blue": "mavi", "green": "yeşil", "yellow": "sarı",
        "orange": "turuncu", "purple": "mor", "brown": "kahverengi", "gold": "altın",
        "silver": "gümüş", "ivory": "fildişi", "khaki": "haki",
    },
    "material": {
        "denim": "kot kumaşı", "leather": "deri", "knit": "triko", "silk": "ipek",
        "wool": "yün", "cotton": "pamuk", "sequin": "pullu", "velvet": "kadife",
        "satin": "saten", "lace": "dantel", "fur": "kürk", "suede": "süet",
    },
    "pattern": {
        "solid": "düz renk", "striped": "çizgili", "floral": "çiçekli", "plaid": "ekose",
        "animal print": "hayvan deseni", "polka dot": "puantiyeli", "none": "desensiz",
        "check": "kareli", "geometric": "geometrik", "logo": "logolu", "print": "baskılı",
    },
}


def tag_label_tr(facet: str, value: str) -> str:
    """Turkish label for a raw Gemini tag word, e.g. tag_label_tr("color",
    "black") -> "siyah". Falls back to the English word itself (title
    case) for anything not in the table above."""
    v = (value or "").strip().lower()
    label = _TAG_LABELS_TR.get(facet, {}).get(v)
    return label or v.replace("_", " ").title()
